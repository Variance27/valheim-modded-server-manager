'use strict';
/*
 * Login for the Valheim GUI.
 *
 *  - One admin account. The password is stored only as a scrypt hash in
 *    auth.json (mode 600) next to server.js — never in config.json.
 *  - Browser sessions use a random token in an HttpOnly, SameSite=Strict
 *    cookie (plus Secure automatically when served over HTTPS / behind a
 *    TLS-terminating tunnel or proxy). Sessions live in memory, so
 *    restarting the GUI logs everyone out.
 *  - Failed logins are rate-limited per IP.
 *  - Every non-GET request must come from this site's own origin AND carry an
 *    "X-VGUI: 1" header, which a cross-site page cannot add (CSRF defence).
 *  - First run: if auth.json doesn't exist, a random password is generated
 *    and printed once in the console. If the old config.json "guiPassword"
 *    is set, it is converted into the first password instead.
 *  - Change the password any time with:  node set-password.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'vgui_session';
const IDLE_MS = 12 * 60 * 60 * 1000; // log out after 12 h without activity
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // …and never keep a session longer than 7 days
const MAX_FAILS = 5; // failed logins per IP before a lockout…
const FAIL_WINDOW_MS = 15 * 60 * 1000; // …within this window
const LOCKOUT_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function authFile(dataDir) {
  return path.join(dataDir, 'auth.json');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, record) {
  try {
    const stored = Buffer.from(record.hash, 'hex');
    const test = crypto.scryptSync(String(password), Buffer.from(record.salt, 'hex'), stored.length, SCRYPT);
    return test.length === stored.length && crypto.timingSafeEqual(test, stored);
  } catch (e) {
    return false;
  }
}

function saveCredentials(dataDir, username, password) {
  const rec = { username: String(username || 'admin'), ...hashPassword(password), updatedAt: new Date().toISOString() };
  const file = authFile(dataDir);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, harmless
  } catch (e) {}
  return rec;
}

function loadCredentials(dataDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(authFile(dataDir), 'utf8'));
    if (rec && rec.username && rec.salt && rec.hash) return rec;
  } catch (e) {}
  return null;
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function install(app, { config, dataDir }) {
  // Behind a tunnel / reverse proxy that terminates TLS, set
  // "trustProxy": true in config.json so Secure cookies and client IPs work.
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  let creds = loadCredentials(dataDir);
  if (!creds) {
    if (config.guiPassword) {
      creds = saveCredentials(dataDir, config.guiUser || 'admin', String(config.guiPassword));
      console.log(
        '\n[auth] Converted the old "guiPassword" from config.json into a hashed login (auth.json).\n' +
          '[auth] You can now delete "guiPassword" from config.json. Username: ' + creds.username + '\n'
      );
    } else {
      const generated = crypto.randomBytes(14).toString('base64url');
      creds = saveCredentials(dataDir, config.guiUser || 'admin', generated);
      console.log(
        '\n=====================================================\n' +
          ' First run: a login has been created for the GUI.\n' +
          `   Username: ${creds.username}\n` +
          `   Password: ${generated}\n` +
          ' This is shown only once. Change it with:  node set-password.js\n' +
          '=====================================================\n'
      );
    }
  }

  const sessions = new Map(); // token -> { user, created, last }
  const failures = new Map(); // ip -> { count, first, lockedUntil }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) {
      if (now - s.last > IDLE_MS || now - s.created > ABSOLUTE_MS) sessions.delete(t);
    }
    for (const [ip, f] of failures) {
      if (now - f.first > FAIL_WINDOW_MS && now > (f.lockedUntil || 0)) failures.delete(ip);
    }
  }, 10 * 60 * 1000);
  sweep.unref();

  function sessionFor(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last > IDLE_MS || now - s.created > ABSOLUTE_MS) {
      sessions.delete(token);
      return null;
    }
    s.last = now;
    return { token, ...s };
  }

  function setCookie(req, res, token, maxAgeSec) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // ---- Security headers on everything ----
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- CSRF: same-origin + custom header on anything that changes state ----
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch (e) {}
      if (!ok) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
    if (req.headers['x-vgui'] !== '1') return res.status(403).json({ error: 'Missing request header.' });
    next();
  });

  // ---- Auth routes (the only ones reachable without a session) ----
  app.get('/api/auth/status', (req, res) => {
    const s = sessionFor(req);
    res.json({ authenticated: !!s, username: s ? s.user : null });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.lockedUntil && now < f.lockedUntil) {
      const wait = Math.ceil((f.lockedUntil - now) / 1000);
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    }
    const { username, password } = req.body || {};
    const userOk =
      typeof username === 'string' &&
      username.length === creds.username.length &&
      crypto.timingSafeEqual(Buffer.from(username), Buffer.from(creds.username));
    // Always run the hash (even for a wrong username) so timing doesn't reveal which half was wrong.
    const passOk = typeof password === 'string' && password.length < 1024 && verifyPassword(password, creds);
    if (userOk && passOk) {
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { user: creds.username, created: now, last: now });
      setCookie(req, res, token, Math.floor(ABSOLUTE_MS / 1000));
      console.log(`[auth] login ok from ${ip}`);
      return res.json({ ok: true });
    }
    const rec = f && now - f.first <= FAIL_WINDOW_MS ? f : { count: 0, first: now, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= MAX_FAILS) rec.lockedUntil = now + LOCKOUT_MS;
    failures.set(ip, rec);
    console.warn(`[auth] failed login from ${ip} (${rec.count}/${MAX_FAILS})`);
    // Small fixed delay slows scripted guessing without tying up the server.
    setTimeout(() => res.status(401).json({ error: 'Wrong username or password.' }), 400);
  });

  app.post('/api/auth/logout', (req, res) => {
    const s = sessionFor(req);
    if (s) sessions.delete(s.token);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    const s = sessionFor(req);
    if (!s) return res.status(401).json({ error: 'Authentication required.' });
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || !verifyPassword(current, creds)) {
      return res.status(403).json({ error: 'Current password is wrong.' });
    }
    if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    creds = saveCredentials(dataDir, creds.username, next);
    for (const t of Array.from(sessions.keys())) if (t !== s.token) sessions.delete(t);
    res.json({ ok: true });
  });

  // ---- Gate: everything below this point needs a valid session ----
  app.use((req, res, next) => {
    if (req.path === '/login.html' || req.path === '/favicon.ico') return next();
    if (sessionFor(req)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required.', login: '/login.html' });
    }
    return res.redirect(302, '/login.html');
  });
}

module.exports = { install, saveCredentials, loadCredentials, MIN_PASSWORD_LENGTH };
