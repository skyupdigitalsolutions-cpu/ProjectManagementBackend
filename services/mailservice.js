// services/mailservice.js  (CommonJS)
// Hostinger webmail bridge: read (IMAP), send/reply/forward (SMTP).
//
// deps:  npm i imapflow mailparser nodemailer

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer       = require('nodemailer');

const IMAP = {
  host: process.env.HOSTINGER_IMAP_HOST || 'imap.hostinger.com',
  port: Number(process.env.HOSTINGER_IMAP_PORT) || 993,
  secure: true,
};
const SMTP = {
  host: process.env.HOSTINGER_SMTP_HOST || 'smtp.hostinger.com',
  port: Number(process.env.HOSTINGER_SMTP_PORT) || 465,
  secure: true,
};

function imapClient({ email, password }) {
  return new ImapFlow({ ...IMAP, auth: { user: email, pass: password }, logger: false });
}

// Validate a mailbox by connecting once. Throws if credentials are wrong.
async function verifyMailbox(creds) {
  const client = imapClient(creds);
  await client.connect();
  await client.logout();
  return true;
}

// List recent messages (envelope only — fast). Newest first.
async function listMessages(creds, box = 'INBOX', limit = 40) {
  const client = imapClient(creds);
  await client.connect();
  const out = [];
  const lock = await client.getMailboxLock(box);
  try {
    const total = client.mailbox.exists;
    if (total > 0) {
      const start = Math.max(1, total - limit + 1);
      for await (const msg of client.fetch(`${start}:*`, {
        uid: true, envelope: true, flags: true, internalDate: true,
      })) {
        out.push({
          uid: msg.uid,
          seen: (msg.flags && msg.flags.has('\\Seen')) || false,
          from: (msg.envelope && msg.envelope.from && msg.envelope.from[0]) || null,
          to: (msg.envelope && msg.envelope.to) || [],
          subject: (msg.envelope && msg.envelope.subject) || '(no subject)',
          date: (msg.envelope && msg.envelope.date) || msg.internalDate,
          messageId: (msg.envelope && msg.envelope.messageId) || null,
        });
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out.reverse();
}

// Fetch one full message (body + attachments) and mark it as seen.
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

// Send a new mail, or a reply/forward (pass inReplyTo + references for threading).
async function sendMessage(creds, {
  to, cc, bcc, subject, text, html, inReplyTo, references, attachments,
}) {
  const transporter = nodemailer.createTransport({
    ...SMTP,
    auth: { user: creds.email, pass: creds.password },
  });
  const info = await transporter.sendMail({
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
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { verifyMailbox, listMessages, getMessage, sendMessage };