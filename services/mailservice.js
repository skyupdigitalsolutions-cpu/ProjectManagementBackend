// services/mailservice.js  (CommonJS)
// Hostinger webmail bridge.
//   READ  over IMAP  (imapflow)  — folders, list, search, read, delete, contacts
//   SEND  over Brevo HTTPS API   — because this host BLOCKS outbound SMTP ports
//   SAVE-TO-SENT over IMAP APPEND (SMTP never saves to Sent by itself)
//
// deps:  npm i imapflow mailparser nodemailer @getbrevo/brevo
//
// Sending requires BREVO_API_KEY in env, and the sender's DOMAIN must be
// authenticated in Brevo (SPF/DKIM) — the same domain you already send with.

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const MailComposer     = require('nodemailer/lib/mail-composer');
const { BrevoClient, BrevoEnvironment } = require('@getbrevo/brevo');

const IMAP = {
  host: process.env.HOSTINGER_IMAP_HOST || 'imap.hostinger.com',
  port: Number(process.env.HOSTINGER_IMAP_PORT) || 993,
  secure: true,
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

// ── send over Brevo HTTPS (SMTP is blocked on this host) ───────────
function parseAddrs(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  return arr
    .map((s) => {
      const m = String(s).match(/<([^>]+)>/);
      const email = (m ? m[1] : s).trim();
      return email ? { email } : null;
    })
    .filter(Boolean);
}

async function sendMessage(creds, {
  to, cc, bcc, subject, text, html, inReplyTo, references, attachments, fromName,
}) {
  if (!process.env.BREVO_API_KEY) {
    const e = new Error('BREVO_API_KEY is not set — cannot send mail (SMTP is blocked on this host).');
    e.code = 'ENOCONFIG';
    throw e;
  }
  const toArr = parseAddrs(to);
  if (toArr.length === 0) { const e = new Error('No valid recipient address'); e.code = 'ENORCPT'; throw e; }

  const payload = {
    sender: { email: creds.email, name: fromName || creds.email },
    replyTo: { email: creds.email, name: fromName || creds.email },
    to: toArr,
    subject: subject || '(no subject)',
    textContent: text && text.trim() ? text : ' ',
    htmlContent: html && html.trim() ? html : (text ? text.replace(/\n/g, '<br>') : ' '),
  };
  const ccArr = parseAddrs(cc); if (ccArr.length) payload.cc = ccArr;
  const bccArr = parseAddrs(bcc); if (bccArr.length) payload.bcc = bccArr;
  const brevoAtt = (attachments || []).map((a) => ({ name: a.filename, content: a.content }));
  if (brevoAtt.length) payload.attachment = brevoAtt;
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references && references.length) headers['References'] = references.join(' ');
  if (Object.keys(headers).length) payload.headers = headers;

  const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY, environment: BrevoEnvironment.Production });
  const result = await client.transactionalEmails.sendTransacEmail(payload);

  // best-effort: save a copy to the Sent folder over IMAP
  await appendToSent(creds, { to, cc, subject, text, html, attachments, inReplyTo, references }).catch(() => {});

  return { messageId: (result && result.messageId) || null, via: 'brevo' };
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