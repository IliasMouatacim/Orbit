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
  const ready = db.execute('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, record BLOB NOT NULL)');
  const sessions = new Map();
  const attempts = new Map();
  let busy = 0;

  async function authenticate(req, res) {
    res.set('Cache-Control', 'no-store');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-z0-9_]{3,23}$/i.test(username) ||
        typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) {
      return res.status(400).json({ error: 'Use 3–23 letters, numbers or underscores and a password of 12–256 bytes (at least 12 characters).' });
    }
    const ip = req.ip;
    if (busy >= 4 || (attempts.get(ip) || 0) >= 30) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!attempts.has(ip)) setTimeout(() => attempts.delete(ip), 10 * 60000).unref();
    attempts.set(ip, (attempts.get(ip) || 0) + 1);
    busy++;
    try {
      const name = '@' + username.toLowerCase();
      const id = crypto.createHmac('sha256', lookupKey).update(name).digest('hex');
      const register = req.path === '/accounts/register';
      let salt = crypto.randomBytes(16);
      let expected;
      const row = register ? null : (await db.execute({
        sql: 'SELECT record FROM accounts WHERE id = ?', args: [id],
      })).rows[0];
      if (!register && row) {
        const record = Buffer.from(row.record);
        const decipher = crypto.createDecipheriv('aes-256-gcm', recordKey, record.subarray(0, 12));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(record.subarray(12, 28));
        const plain = Buffer.concat([decipher.update(record.subarray(28)), decipher.final()]);
        salt = plain.subarray(0, 16);
        expected = plain.subarray(16);
      }
      const hash = await derive(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
      if (register) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', recordKey, iv);
        cipher.setAAD(Buffer.from(id));
        const body = Buffer.concat([cipher.update(Buffer.concat([salt, hash])), cipher.final()]);
        const result = await db.execute({
          sql: 'INSERT OR IGNORE INTO accounts (id, record) VALUES (?, ?)',
          args: [id, Buffer.concat([iv, cipher.getAuthTag(), body])],
        });
        if (!result.rowsAffected) {
          return res.status(409).json({ error: 'That account name is taken.' });
        }
      } else if (!expected || !crypto.timingSafeEqual(expected, hash)) {
        return res.status(401).json({ error: 'Incorrect username or password.' });
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
