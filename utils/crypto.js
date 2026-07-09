// utils/crypto.js  (CommonJS)
// AES-256-GCM helpers for encrypting mailbox passwords at rest.
//
// Set MAIL_ENC_KEY in your environment to a long random string
// (e.g. `openssl rand -base64 48`). Keep it OUT of source control.
// If this key changes, previously stored passwords can no longer be
// decrypted and users must reconnect their mailbox.

const crypto = require('crypto');

const KEY = crypto
  .createHash('sha256')
  .update(process.env.MAIL_ENC_KEY || 'CHANGE_ME_IN_ENV')
  .digest(); // 32 bytes

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  const [ivB, tagB, dataB] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };