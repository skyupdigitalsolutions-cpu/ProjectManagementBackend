// services/mailservice.js  (CommonJS)
// Hostinger webmail bridge: read (IMAP), send/reply/forward (SMTP),
// folders, search, contacts, and save-to-Sent.
//
// deps:  npm i imapflow mailparser nodemailer

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer       = require('nodemailer');
const MailComposer     = require('nodemailer/lib/mail-composer');

const IMAP = {
  host: process.env.HOSTINGER_IMAP_HOST || 'imap.hostinger.com',
  port: Number(process.env.HOSTINGER_IMAP_PORT) || 993,
  secure: true,
};
const SMTP_HOST = process.env.HOSTINGER_SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT = Number(process.env.HOSTINGER_SMTP_PORT) || 465;

function imapClient({ email, password }) {
  return new ImapFlow({
    ...IMAP,
    auth: { user: email, pass: password },
    logger: false,
    // fail fast instead of hanging the request/gateway
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
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
  try {
    list = await client.list();
  } finally {
    await client.logout();
  }
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
    let seq;
    if (search && search.trim()) {
      const q = search.trim();
      const uids = await client.search(
        { or: [{ header: { subject: q } }, { header: { from: q } }, { body: q }] },
        { uid: true }
      );
      if (!uids || uids.length === 0) return [];
      seq = uids.slice(-limit); // newest matches
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
            const people = []
              .concat(env.from || [])
              .concat(env.to || [])
              .concat(env.cc || []);
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
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }
  const me = creds.email.toLowerCase();
  return [...map.values()]
    .filter((c) => c.address.toLowerCase() !== me)
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

// ── send (with 465 → 587 fallback), then append to Sent ────────────
async function sendMessage(creds, {
  to, cc, bcc, subject, text, html, inReplyTo, references, attachments,
}) {
  const mailOptions = {
    from: creds.email,
    to, cc, bcc, subject,
    text: text || undefined,
    html: html || undefined,
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType,
    })),
  };

  // Try the configured port first, then the other common Hostinger port.
  const primary = { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465 };
  const alt = SMTP_PORT === 465
    ? { host: SMTP_HOST, port: 587, secure: false, requireTLS: true }
    : { host: SMTP_HOST, port: 465, secure: true };

  const CONN_ERRS = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ETLS'];
  let lastErr;
  for (const cfg of [primary, alt]) {
    try {
      const transporter = nodemailer.createTransport({
        ...cfg,
        auth: { user: creds.email, pass: creds.password },
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
      });
      const info = await transporter.sendMail(mailOptions);
      // best-effort: save a copy to the Sent folder (SMTP does not do this)
      await appendToSent(creds, mailOptions).catch(() => {});
      return { messageId: info.messageId, accepted: info.accepted, port: cfg.port };
    } catch (e) {
      lastErr = e;
      if (!CONN_ERRS.includes(e.code)) throw e; // auth/other errors: don't retry
    }
  }
  throw lastErr;
}

async function appendToSent(creds, mailOptions) {
  const raw = await new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  const client = imapClient(creds);
  await client.connect();
  try {
    const folders = await client.list();
    const sent = folders.find((f) => f.specialUse === '\\Sent');
    const target = sent ? sent.path : 'INBOX.Sent';
    await client.append(target, raw, ['\\Seen']);
  } finally {
    await client.logout();
  }
}

module.exports = {
  verifyMailbox,
  listFolders,
  listMessages,
  getMessage,
  deleteMessage,
  getContacts,
  sendMessage,
};