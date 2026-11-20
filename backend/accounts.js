const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const derive = promisify(crypto.scrypt);
const hour = 3600000;

function openAccounts() {
  const dir = process.env.ACCOUNT_DATA_DIR || path.join(__dirname, '.accounts');
  const remote = process.env.TURSO_DATABASE_URL;
  if (remote || process.env.TURSO_AUTH_TOKEN || process.env.RENDER === 'true') {
    if (!/^(libsql|https):\/\//.test(remote || '') || !process.env.TURSO_AUTH_TOKEN) {
      throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for hosted account storage.');
    }
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  let key;
  if (remote || process.env.ACCOUNT_KEY || process.env.NODE_ENV === 'production') {
    if (!/^[0-9a-f]{64}$/i.test(process.env.ACCOUNT_KEY || '')) {
      throw new Error('Set ACCOUNT_KEY to a 32-byte hex key.');
    }
    key = Buffer.from(process.env.ACCOUNT_KEY, 'hex');
  } else {
    const file = path.join(dir, 'development.key');
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    key = fs.readFileSync(file);
  }
  const lookupKey = crypto.hkdfSync('sha256', key, '', 'orbit account lookup', 32);
  const recordKey = crypto.hkdfSync('sha256', key, '', 'orbit account records', 32);
  const db = createClient(remote
    ? { url: remote, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: pathToFileURL(path.join(dir, 'accounts.sqlite')).href });
  const ready = db.batch([
    'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, record BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS account_emails (email_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE)',
  ], 'write');
  const emailId = email => crypto.createHmac('sha256', lookupKey).update('email:' + email).digest('hex');
  const sessions = new Map();
  const attempts = new Map();
  let busy = 0;

  async function authenticate(req, res) {
    res.set('Cache-Control', 'no-store');
    const { username, password, email } = req.body || {};
    const register = req.path === '/accounts/register';
    const identifier = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const emailLogin = !register && identifier.includes('@');
    const address = emailLogin ? identifier : typeof email === 'string' ? email.trim().toLowerCase() : '';
    if ((emailLogin || (register && email !== undefined && email !== '')) &&
        (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if ((!emailLogin && !/^[a-z0-9_]{3,23}$/.test(identifier)) ||
        typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) {
      return res.status(400).json({ error: 'Check your username or email and enter a password of at least 12 characters.' });
    }
    const ip = req.ip;
    if (busy >= 4 || (attempts.get(ip) || 0) >= 30) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!attempts.has(ip)) setTimeout(() => attempts.delete(ip), 10 * 60000).unref();
    attempts.set(ip, (attempts.get(ip) || 0) + 1);
    busy++;
    try {
      let name = '@' + identifier;
      let id = crypto.createHmac('sha256', lookupKey).update(name).digest('hex');
      let salt = crypto.randomBytes(16);
      let expected;
      const row = register ? null : (await db.execute({
        sql: emailLogin
          ? 'SELECT id, record FROM accounts JOIN account_emails ON account_id = id WHERE email_id = ?'
          : 'SELECT id, record FROM accounts WHERE id = ?',
        args: [emailLogin ? emailId(address) : id],
      })).rows[0];
      if (!register && row) {
        id = row.id;
        const record = Buffer.from(row.record);
        const decipher = crypto.createDecipheriv('aes-256-gcm', recordKey, record.subarray(0, 12));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(record.subarray(12, 28));
        const plain = Buffer.concat([decipher.update(record.subarray(28)), decipher.final()]);
        salt = plain.subarray(0, 16);
        expected = plain.subarray(16, 48);
        if (emailLogin) name = plain.subarray(48).toString();
      }
      const hash = await derive(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
      if (register) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', recordKey, iv);
        cipher.setAAD(Buffer.from(id));
        const body = Buffer.concat([cipher.update(Buffer.concat([salt, hash, Buffer.from(name)])), cipher.final()]);
        const inserts = [{
          sql: 'INSERT INTO accounts (id, record) VALUES (?, ?)',
          args: [id, Buffer.concat([iv, cipher.getAuthTag(), body])],
        }];
        if (address) inserts.push({
          sql: 'INSERT INTO account_emails (email_id, account_id) VALUES (?, ?)',
          args: [emailId(address), id],
        });
        try {
          await db.batch(inserts, 'write');
        } catch (error) {
          if (!String(error.code).startsWith('SQLITE_CONSTRAINT') && !error.message.includes('UNIQUE constraint failed')) throw error;
          return res.status(409).json({ error: 'That username or email is already in use.' });
        }
      } else if (!expected || !crypto.timingSafeEqual(expected, hash)) {
        return res.status(401).json({ error: 'Incorrect username, email, or password.' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const session = { name, expires: Date.now() + 8 * hour };
      sessions.set(token, session);
      setTimeout(() => sessions.delete(token), 8 * hour).unref();
      res.json({ name, token });
    } finally {
      busy--;
    }
  }
  return { authenticate, sessions, ready };
}

module.exports = { openAccounts };
