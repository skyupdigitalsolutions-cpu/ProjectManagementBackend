// services/mailservice.js  (CommonJS)
// Hostinger webmail bridge.
//   READ  over IMAP  (imapflow)            — folders, list, search, read, delete, contacts
//   SEND  over Hostinger SMTP (nodemailer)  — authenticated as the employee's own
//          mailbox, so mail genuinely goes out FROM their address.
//   SAVE-TO-SENT over IMAP APPEND           — SMTP never saves to Sent by itself.
//
// deps:  npm i imapflow mailparser nodemailer
//
// Sending uses the SAME Hostinger credentials the employee connected with (the
// ones already used for IMAP) — no third-party relay and no API key needed.
// Hetzner only blocks bare outbound port 25; the submission ports Hostinger
// uses (465 implicit-TLS / 587 STARTTLS) are open, so direct SMTP works here.

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer       = require('nodemailer');
const MailComposer     = require('nodemailer/lib/mail-composer');

const IMAP = {
  host: process.env.HOSTINGER_IMAP_HOST || 'imap.hostinger.com',
  port: Number(process.env.HOSTINGER_IMAP_PORT) || 993,
  secure: true,
};

const SMTP = {
  host: process.env.HOSTINGER_SMTP_HOST || 'smtp.hostinger.com',
  // 465 = implicit TLS (SMTPS). Set HOSTINGER_SMTP_PORT=587 for STARTTLS.
  port: Number(process.env.HOSTINGER_SMTP_PORT) || 465,
  // secure:true for 465, false for 587. Overridable via HOSTINGER_SMTP_SECURE.
  secure: process.env.HOSTINGER_SMTP_SECURE
    ? process.env.HOSTINGER_SMTP_SECURE === 'true'
    : (Number(process.env.HOSTINGER_SMTP_PORT) || 465) === 465,
};

function imapClient({ email, password }) {
  const client = new ImapFlow({
    ...IMAP,
    auth: { user: email, pass: password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
  // ImapFlow is an EventEmitter. If the underlying TCP socket errors — the host
  // resets the connection, blocks outbound port 993, times out, etc. — and
  // NOTHING is listening for 'error', Node re-throws it as an uncaughtException
  // and the ENTIRE server process dies (taking every other user's requests with
  // it). This no-op logging listener keeps that error local: the in-flight
  // operation still rejects and is handled by the route's own try/catch.
  client.on('error', (err) => {
    console.error(
      '[mail] imap client error:',
      err && err.message ? err.message : err,
    );
  });
  return client;
}

// ── credential check ───────────────────────────────────────────────
async function verifyMailbox(creds) {
  const client = imapClient(creds);
  await client.connect();
  await client.logout();
  return true;
}

// ── folders (with special-use mapping) ─────────────────────────────
async function listFolders(creds) {
  const client = imapClient(creds);
  await client.connect();
  let list = [];
  try { list = await client.list(); }
  finally { await client.logout(); }
  return list
    .filter((f) => !f.flags || !f.flags.has('\\Noselect'))
    .map((f) => ({
      path: f.path,
      name: f.name,
      specialUse: f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
    }));
}

// ── list / search messages in a box ────────────────────────────────
async function listMessages(creds, { box = 'INBOX', limit = 40, search = '' } = {}) {
  const client = imapClient(creds);
  await client.connect();
  const out = [];
  const lock = await client.getMailboxLock(box);
  try {
    if (search && search.trim()) {
      const q = search.trim();
      const uids = await client.search(
        { or: [{ header: { subject: q } }, { header: { from: q } }, { body: q }] },
        { uid: true }
      );
      if (!uids || uids.length === 0) return [];
      const seq = uids.slice(-limit);
      for await (const msg of client.fetch(seq, {
        uid: true, envelope: true, flags: true, internalDate: true,
      }, { uid: true })) {
        out.push(shapeEnvelope(msg));
      }
    } else {
      const total = client.mailbox.exists;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:*`, {
          uid: true, envelope: true, flags: true, internalDate: true,
        })) {
          out.push(shapeEnvelope(msg));
        }
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out.reverse();
}

function shapeEnvelope(msg) {
  const env = msg.envelope || {};
  return {
    uid: msg.uid,
    seen: (msg.flags && msg.flags.has('\\Seen')) || false,
    from: (env.from && env.from[0]) || null,
    to: env.to || [],
    subject: env.subject || '(no subject)',
    date: env.date || msg.internalDate,
    messageId: env.messageId || null,
  };
}

// ── read one full message ──────────────────────────────────────────
async function getMessage(creds, uid, box = 'INBOX') {
  const client = imapClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(box);
  let parsed;
  try {
    const { content } = await client.download(uid, null, { uid: true });
    parsed = await simpleParser(content);
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
  } finally {
    lock.release();
    await client.logout();
  }
  return {
    uid,
    subject: parsed.subject || '(no subject)',
    from: (parsed.from && parsed.from.value && parsed.from.value[0]) || null,
    to: (parsed.to && parsed.to.value) || [],
    cc: (parsed.cc && parsed.cc.value) || [],
    date: parsed.date,
    messageId: parsed.messageId,
    references: []
      .concat(parsed.references || [])
      .concat(parsed.messageId ? [parsed.messageId] : []),
    html: parsed.html || null,
    text: parsed.text || '',
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      content: a.content ? a.content.toString('base64') : null,
    })),
  };
}

// ── delete (move to Trash if possible, else flag deleted) ──────────
async function deleteMessage(creds, uid, box = 'INBOX') {
  const client = imapClient(creds);
  await client.connect();
  const lock = await client.getMailboxLock(box);
  try {
    const folders = await client.list();
    const trash = folders.find((f) => f.specialUse === '\\Trash');
    if (trash && trash.path !== box) {
      await client.messageMove(uid, trash.path, { uid: true });
    } else {
      await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return true;
}

// ── contacts derived from mail participants (INBOX + Sent) ─────────
async function getContacts(creds, perBox = 200) {
  const client = imapClient(creds);
  await client.connect();
  const map = new Map();
  try {
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent');
    const boxes = ['INBOX'];
    if (sent) boxes.push(sent.path);
    for (const box of boxes) {
      const lock = await client.getMailboxLock(box);
      try {
        const total = client.mailbox.exists;
        if (total > 0) {
          const start = Math.max(1, total - perBox + 1);
          for await (const msg of client.fetch(`${start}:*`, { envelope: true })) {
            const env = msg.envelope || {};
            const people = [].concat(env.from || []).concat(env.to || []).concat(env.cc || []);
            for (const p of people) {
              if (!p || !p.address) continue;
              const key = p.address.toLowerCase();
              if (!map.has(key)) map.set(key, { name: p.name || '', address: p.address, count: 0 });
              const rec = map.get(key);
              rec.count += 1;
              if (!rec.name && p.name) rec.name = p.name;
            }
          }
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout(); }
  const me = creds.email.toLowerCase();
  return [...map.values()]
    .filter((c) => c.address.toLowerCase() !== me)
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

// ── send over Hostinger SMTP (authenticated as the employee) ───────
// Normalises a recipient field to something nodemailer accepts directly:
// takes a comma-separated string or an array, returns a trimmed string (or
// undefined when empty). nodemailer parses "Name <addr>" forms itself.
function addrList(input) {
  if (!input) return undefined;
  const s = Array.isArray(input) ? input.join(', ') : String(input);
  return s.trim() ? s : undefined;
}

async function sendMessage(creds, {
  to, cc, bcc, subject, text, html, inReplyTo, references, attachments, fromName,
}) {
  const toList = addrList(to);
  if (!toList) { const e = new Error('No valid recipient address'); e.code = 'ENORCPT'; throw e; }

  // Prefer whatever the client sent; guarantee at least one non-empty part so an
  // attachment-only message still carries a valid (blank) body.
  const htmlBody = html && html.trim() ? html : undefined;
  let textBody = text && text.trim() ? text : undefined;
  if (!htmlBody && !textBody) textBody = ' ';

  const mail = {
    from: fromName ? { name: fromName, address: creds.email } : creds.email,
    to: toList,
    cc: addrList(cc),
    bcc: addrList(bcc),
    subject: subject || '(no subject)',
    text: textBody,
    html: htmlBody,
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content || '', 'base64'),
      contentType: a.contentType || undefined,
    })),
  };

  const transporter = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: { user: creds.email, pass: creds.password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  let info;
  try {
    info = await transporter.sendMail(mail);
  } finally {
    transporter.close();
  }

  // SMTP does not file a copy in Sent — do it ourselves over IMAP (best effort).
  await appendToSent(creds, { to, cc, subject, text, html, attachments, inReplyTo, references }).catch(() => {});

  return { messageId: (info && info.messageId) || null, via: 'hostinger-smtp' };
}

async function appendToSent(creds, m) {
  const mailOptions = {
    from: creds.email,
    to: m.to, cc: m.cc, subject: m.subject,
    text: m.text || undefined,
    html: m.html || undefined,
    inReplyTo: m.inReplyTo || undefined,
    references: m.references && m.references.length ? m.references : undefined,
    attachments: (m.attachments || []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType,
    })),
  };
  const raw = await new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  const client = imapClient(creds);
  await client.connect();
  try {
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent');
    await client.append(sent ? sent.path : 'INBOX.Sent', raw, ['\\Seen']);
  } finally {
    await client.logout();
  }
}

module.exports = {
  verifyMailbox, listFolders, listMessages, getMessage,
  deleteMessage, getContacts, sendMessage,
};