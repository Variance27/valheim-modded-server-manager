// The Express app: body parsing, login (auth.js), world selection per request, static files.

const express = require('express');
const path = require('path');
const { config, ROOT, INSTANCE_ID_RE, getInstanceCtx, als, instanceCtx } = require('./context');

// ---- Express app ----

const app = express();

// Login (see auth.js): session cookie + hashed password in auth.json, rate
// limiting, CSRF protection. Always on — a random password is generated and
// printed on first run (or the old guiPassword from config.json is converted).
// Must come after express.json() (the login route reads the body) and before
// the static files and every /api route, so nothing is reachable without it.
app.use(express.json());
require('../auth').install(app, { config, dataDir: ROOT });

// Which world a request is for: ?instance= / X-Instance (explicit, used by the Worlds page), else the
// vg_instance cookie set by the world switcher, else the main world.
app.use((req, res, next) => {
  const explicit = (req.query && req.query.instance) || req.get('x-instance') || '';
  const ck = /(?:^|;\s*)vg_instance=([a-z0-9]+)/.exec(req.headers.cookie || '');
  const id = String(explicit || (ck && ck[1]) || 'main');
  const ctx = INSTANCE_ID_RE.test(id) || id === 'main' ? getInstanceCtx(id) : null;
  if (!ctx) {
    if (explicit) return res.status(404).json({ error: `Unknown world "${id}"` });
    return als.run(instanceCtx.get('main'), next); // stale cookie (a world that was removed): use the main world
  }
  als.run(ctx, next);
});
// Notes mod installs/removals for the restart-required banner (src/pending.js). Loaded on first
// use because pending.js itself needs this app.
app.use('/api/mods', (req, res, next) => require('./pending').trackModChange(req, res, next));
app.use(express.static(path.join(ROOT, 'public')));

Object.assign(module.exports, { app });
