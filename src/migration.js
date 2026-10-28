// Moving worlds to a new VPS (export, upload, verify, import).

const path = require('path');
const migration = require('../migration');
const { readRegistry, config, writeRegistry } = require('./context');
const { Client, sshConnectOpts, sshExec, LOCAL_MODE, sshExecPlainStream, maybeSudo, shq } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const worldInfo = require('./world-info');
const bot = require('./bot');
const setup = require('./setup');

// ---- Migration to a new VPS (API: /api/migration/*) ----
//
// Export: on the old VPS everything that makes a world (saves, LinuxGSM config, BepInEx mods and configs)
// is packed into a staging folder under /var/tmp/vgui-migration, then the finished bundle is streamed
// through this GUI to a file on your PC. Import: after the new VPS has been through Setup, the bundle is
// uploaded to it, every part is checked against its checksum, and each world is unpacked. Anything the
// import replaces is moved to ~/pre-migration-<time> in that world's home, never deleted. The bundle holds
// the server password and Mods.yaml, so treat the file like a password. See migration.js for the format.
const migTs = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// Stream a command's raw stdout into an HTTP response (binary-safe, with backpressure).
function sshBinaryOut(command, res, onDone) {
  const conn = new Client();
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    try {
      conn.end();
    } catch (e) {}
    if (err && !res.headersSent) res.status(500).json({ error: err });
    else if (err) res.destroy(new Error(err));
    else res.end();
    if (onDone) onDone(err);
  };
  conn
    .on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(err.message);
        let stderr = '';
        res.on('close', () => {
          if (!done) {
            try {
              stream.close();
            } catch (e) {}
            finish('download cancelled');
          }
        });
        stream.on('data', (d) => {
          if (!res.write(d)) {
            stream.pause();
            res.once('drain', () => stream.resume());
          }
        });
        stream.stderr.on('data', (d) => (stderr += d.toString()));
        stream.on('close', (code) => finish(code === 0 || code === 1 || code === undefined || code === null ? null : `the VPS command failed (${code}): ${stderr.trim().slice(0, 300)}`));
      });
    })
    .on('error', (e) => finish(e.message))
    .connect(sshConnectOpts());
}

// Pipe a readable (the upload request) into a command's stdin; resolves { code, stderr, bytes }.
function sshStdinIn(command, readable) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch (e) {}
      resolve(r);
    };
    conn
      .on('ready', () => {
        conn.exec(command, { stdin: true }, (err, stream) => {
          if (err) return done({ code: 1, stderr: err.message, bytes: 0 });
          let stderr = '';
          let bytes = 0;
          stream.stderr.on('data', (d) => (stderr += d.toString()));
          stream.on('data', () => {}); // keep the channel flowing
          stream.on('close', (code) => done({ code: code == null ? 1 : code, stderr, bytes }));
          readable.on('data', (chunk) => {
            bytes += chunk.length;
            if (!stream.write(chunk)) {
              readable.pause();
              stream.once('drain', () => readable.resume());
            }
          });
          readable.on('end', () => stream.end());
          readable.on('error', () => {
            try {
              stream.close();
            } catch (e) {}
          });
          readable.on('aborted', () => {
            try {
              stream.close();
            } catch (e) {}
          });
        });
      })
      .on('error', (e) => done({ code: 1, stderr: e.message, bytes: 0 }))
      .connect(sshConnectOpts());
  });
}

// What the scripts need to know about one world, taken from the config the GUI already derives.
function migWorldSpec(id) {
  return worldsPage.inWorld(id, async () => {
    const reg = readRegistry().find((i) => i.id === id);
    return migration.checkSpec({
      id,
      label: config.instance.label,
      user: config.lgsmUser,
      lgsmServer: config.lgsmServer,
      home: config.lgsmHome,
      listDir: config.paths.listDir,
      serverDir: config.paths.valheimServerDir,
      cfgDir: path.posix.dirname(config.paths.commonCfgPath),
      plannedPort: reg && reg.plannedPort ? reg.plannedPort : null,
    });
  });
}

async function migPreview(ids) {
  const specs = [];
  const errors = {};
  for (const id of ids) {
    try {
      specs.push(await migWorldSpec(id));
    } catch (e) {
      errors[id] = e.message;
    }
  }
  const out = { freeMB: null, worlds: [], errors };
  if (!specs.length) return out;
  const r = await sshExec(setup.asRootScript(migration.previewScript(specs)));
  out.freeMB = Math.round(Number((/FREE_KB:(\d+)/.exec(r.stdout) || [])[1] || 0) / 1024);
  for (const line of r.stdout.split('\n')) {
    const m = /^W\|([a-z0-9]+)\|([01])\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|([01])\|([01])\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const spec = specs.find((x) => x.id === m[1]);
    out.worlds.push({
      id: m[1],
      label: spec ? spec.label : m[1],
      account: spec ? spec.user : null,
      accountExists: m[2] === '1',
      running: Number(m[3]) > 0,
      savesKB: Number(m[4]),
      modsKB: Number(m[5]),
      extrasKB: Number(m[6]),
      hasLgsmConfig: m[7] === '1',
      bepinexInstalled: m[8] === '1',
      worlds: m[9] ? m[9].split(',') : [],
    });
  }
  return out;
}

app.get('/api/migration/preview', async (req, res) => {
  try {
    res.json({ ...(await migPreview(worldsPage.worldList())), host: LOCAL_MODE ? 'this machine' : `${config.ssh.username}@${config.ssh.host}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Build the bundle on this VPS (streams progress; ends with "EXPORT_READY <token> <bytes>").
app.post('/api/migration/export', async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.worlds) ? b.worlds.map(String) : [];
  const all = worldsPage.worldList();
  if (!ids.length || ids.some((i) => !all.includes(i)) || new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Choose at least one of your worlds.' });
  if (!b.saves && !b.mods) return res.status(400).json({ error: 'Choose what to include: saves, mods, or both.' });
  try {
    const specs = [];
    for (const id of ids) specs.push(await migWorldSpec(id));
    const token = migTs();
    const manifest = migration.buildManifest({ guiVersion: require('../package.json').version, includes: { saves: !!b.saves, mods: !!b.mods }, worlds: specs });
    const script = migration.exportScript({ token, worlds: specs, saves: !!b.saves, mods: !!b.mods, allowRunning: b.allowRunning === true, manifestJson: JSON.stringify(manifest, null, 2) });
    sshExecPlainStream(setup.asRootScript(script), res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/migration/download/:token', async (req, res) => {
  const token = req.params.token;
  if (!migration.TOKEN_RE.test(token)) return res.status(400).json({ error: 'Bad bundle id.' });
  try {
    const chk = await sshExec(maybeSudo(`test -f ${shq(`${migration.STAGE_ROOT}/export-${token}/manifest.json`)}`) + ' && echo OK');
    if (!chk.stdout.includes('OK')) return res.status(404).json({ error: 'That bundle no longer exists on the VPS. Export again.' });
    res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="valheim-migration-${token}.tar"`, 'Cache-Control': 'no-store' });
    sshBinaryOut(maybeSudo(migration.downloadCommand(token)), res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Remove a staged export or import (only folders this feature created, named by a 14-digit time stamp).
app.delete('/api/migration/:kind/:token', async (req, res) => {
  const { kind, token } = req.params;
  if (!['export', 'import'].includes(kind) || !migration.TOKEN_RE.test(token)) return res.status(400).json({ error: 'Bad request.' });
  try {
    await sshExec(maybeSudo(`rm -rf ${shq(`${migration.STAGE_ROOT}/${kind}-${token}`)}`));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Receive the bundle (raw request body) and write it to the VPS this GUI is connected to.
app.post('/api/migration/upload', async (req, res) => {
  const expected = Number(req.get('x-bundle-size') || 0);
  const token = migTs();
  const dir = `${migration.STAGE_ROOT}/import-${token}`;
  try {
    const prep = await sshExec(
      setup.asRootScript(
        [`ROOT=${shq(migration.STAGE_ROOT)}`, 'mkdir -p "$ROOT" && chmod 700 "$ROOT"', 'for old in "$ROOT"/import-*; do [ -d "$old" ] && rm -rf "$old"; done', `mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)} && echo READY`].join('\n')
      )
    );
    if (!prep.stdout.includes('READY')) return res.status(500).json({ error: `Could not prepare ${migration.STAGE_ROOT} on the VPS: ${prep.stderr.trim()}` });
    const file = `${dir}/bundle.tar`;
    const r = await sshStdinIn(`${maybeSudo(`tee ${shq(file)}`)} >/dev/null`, req);
    if (r.code !== 0) return res.status(500).json({ error: `The upload to the VPS failed: ${r.stderr.trim() || `exit ${r.code}`}` });
    const size = Number(((await sshExec(maybeSudo(`stat -c %s ${shq(file)}`))).stdout || '').trim());
    if (expected && size !== expected) {
      await sshExec(maybeSudo(`rm -rf ${shq(dir)}`));
      return res.status(400).json({ error: `Only ${size} of ${expected} bytes arrived. The upload was cut short, try again.` });
    }
    res.json({ ok: true, token, bytes: size });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// What an uploaded bundle holds and what each of its worlds would be unpacked into on this VPS.
app.get('/api/migration/inspect/:token', async (req, res) => {
  const token = req.params.token;
  if (!migration.TOKEN_RE.test(token)) return res.status(400).json({ error: 'Bad bundle id.' });
  try {
    const mf = await sshExec(maybeSudo(migration.readBundleCommand(token, 'manifest.json')));
    const parsed = migration.parseManifest(mf.stdout);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const partsOut = await sshExec(maybeSudo(migration.listPartsCommand(token)));
    const parts = {};
    for (const line of partsOut.stdout.split('\n')) {
      const m = /^worlds\/([a-z0-9]+)\/(saves|lgsm|bepinex|extras)\.tgz$/.exec(line.trim());
      if (m) (parts[m[1]] = parts[m[1]] || []).push(`${m[2]}.tgz`);
    }
    const inRegistry = new Set(worldsPage.worldList());
    const present = parsed.manifest.worlds.filter((w) => inRegistry.has(w.id)).map((w) => w.id);
    const preview = await migPreview(present);
    const targets = parsed.manifest.worlds.map((w) => {
      const p = preview.worlds.find((x) => x.id === w.id) || null;
      return { ...w, parts: parts[w.id] || [], known: inRegistry.has(w.id), target: p, targetError: preview.errors[w.id] || null };
    });
    res.json({ token, manifest: { createdAt: parsed.manifest.createdAt, guiVersion: parsed.manifest.guiVersion, includes: parsed.manifest.includes }, targets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/migration/verify/:token', (req, res) => {
  const token = req.params.token;
  if (!migration.TOKEN_RE.test(token)) return res.status(400).json({ error: 'Bad bundle id.' });
  sshExecPlainStream(setup.asRootScript(migration.verifyScript(token)), res);
});

// Worlds that exist in the bundle but not in this GUI's list get an entry with the same id (so the game
// account name is the same); their VPS setup still has to be run from Setup.
app.post('/api/migration/prepare', async (req, res) => {
  const token = String((req.body && req.body.token) || '');
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
  if (!migration.TOKEN_RE.test(token)) return res.status(400).json({ error: 'Bad bundle id.' });
  try {
    const parsed = migration.parseManifest((await sshExec(maybeSudo(migration.readBundleCommand(token, 'manifest.json')))).stdout);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const reg = readRegistry();
    const created = [];
    for (const id of ids) {
      const w = parsed.manifest.worlds.find((x) => x.id === id);
      if (!w || id === 'main' || reg.some((i) => i.id === id)) continue;
      if (reg.length >= 8) return res.status(400).json({ error: 'The GUI manages at most 8 extra worlds.' });
      let label = w.label;
      for (let n = 2; reg.some((i) => i.label.toLowerCase() === label.toLowerCase()); n++) label = `${w.label.slice(0, 27)} ${n}`;
      const mainPort = (await worldsPage.inWorld('main', () => worldInfo.getWorldInfo())).port || 2456;
      const used = new Set([mainPort, ...reg.map((i) => i.plannedPort).filter(Boolean)]);
      let plannedPort = w.plannedPort || mainPort + 10;
      while ([...used].some((p) => worldsPage.portsOverlap(p, plannedPort))) plannedPort += 10;
      const entry = { id, label, lgsmUser: `vhserver-${id}`, lgsmServer: w.lgsmServer || 'vhserver', plannedPort, created: new Date().toISOString() };
      reg.push(entry);
      created.push(entry);
    }
    if (created.length) {
      writeRegistry(reg);
      bot.syncBotWorlds().catch(() => {});
    }
    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unpack one world from an uploaded bundle (streams progress; the last lines say IMPORTED, [collision],
// [running] or [error]).
app.post('/api/migration/import', async (req, res) => {
  const b = req.body || {};
  const token = String(b.token || '');
  const id = String(b.id || '');
  if (!migration.TOKEN_RE.test(token) || !worldsPage.worldList().includes(id)) return res.status(400).json({ error: 'Unknown bundle or world.' });
  if (!b.saves && !b.mods) return res.status(400).json({ error: 'Choose what to import: saves, mods, or both.' });
  try {
    const parsed = migration.parseManifest((await sshExec(maybeSudo(migration.readBundleCommand(token, 'manifest.json')))).stdout);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const mw = parsed.manifest.worlds.find((x) => x.id === id);
    if (!mw) return res.status(400).json({ error: `The bundle has no world "${id}".` });
    const parts = (await sshExec(maybeSudo(migration.listPartsCommand(token)))).stdout
      .split('\n')
      .map((l) => /^worlds\/([a-z0-9]+)\/((?:saves|lgsm|bepinex|extras)\.tgz)$/.exec(l.trim()))
      .filter((m) => m && m[1] === id)
      .map((m) => m[2]);
    const w = await migWorldSpec(id);
    const script = migration.importScript({ token, w, parts, oldHome: mw.home, overwrite: b.overwrite === true, doSaves: !!b.saves, doMods: !!b.mods, ts: migTs() });
    sshExecPlainStream(setup.asRootScript(script), res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
