// Mod actions: install, update, remove, disable, history/rollback, codes and pins.

const modgraph = require('../modgraph');
const modsets = require('../modsets');
const { config } = require('./context');
const { changesWebhook } = require('./notify');
const { sshExec, shq, sshExecPlainStream, notifyDiscord, sshExecStream } = require('./exec');
const { app } = require('./app');
const worldInfo = require('./world-info');
const modData = require('./mod-data');
const packageCache = require('./package-cache');
const modCatalog = require('./mod-catalog');
const setup = require('./setup');

// ---- Mod snapshots (Mods > History) ----
// Before any install, update or removal the GUI saves the list of installed mods (folder, package,
// version, source) as a small JSON file next to the world's other files, so a bad update can be undone.
// The nightly backup also writes the same list (<world>-<date>-mods.txt), so older states can be
// restored from backups too. Restoring never touches mod configs or the world; it only reinstalls or
// removes mod folders, and the user confirms a plan first.
const SNAP_ID_RE = /^\d{8}-\d{6}$/;
const BACKUP_MODS_RE = /^[A-Za-z0-9_.-]+-mods\.txt$/;
const SNAP_KEEP = 30;
const SNAP_MIN_GAP_MS = 90 * 1000;
const snapDir = () => `${config.lgsmHome}/mod-snapshots`;

async function captureModSet() {
  const [lsr, recs] = await Promise.all([
    sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`),
    modData.loadInstalledFrom().catch(() => ({})),
  ]);
  return modsets.entriesFromFolders(lsr.stdout.split('\n').filter(Boolean), recs);
}

// Reads files that a loop printed as "@@@<header>\n<content>" blocks.
function parseBlocks(stdout) {
  return stdout
    .split('@@@')
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      return { header: chunk.slice(0, nl).trim(), body: chunk.slice(nl + 1).trim() };
    });
}

async function readSnapshots() {
  const d = snapDir();
  const r = await sshExec(
    `d=${shq(d)}; [ -d "$d" ] && for f in $(ls -1 "$d" | grep -E '^[0-9]{8}-[0-9]{6}\\.json$' | sort -r); do echo "@@@$f"; cat "$d/$f"; echo; done; true`
  );
  const out = [];
  for (const b of parseBlocks(r.stdout)) {
    try {
      const j = JSON.parse(b.body);
      if (j && SNAP_ID_RE.test(j.id) && Array.isArray(j.mods)) out.push(j);
    } catch (e) {}
  }
  return out;
}

// Best-effort: a failure here must never block the install/remove it protects.
async function takeModSnapshot(reason, { force = false } = {}) {
  try {
    const mods = await captureModSet();
    if (!force && !mods.length) return null;
    const existing = await readSnapshots();
    const latest = existing[0];
    const now = new Date();
    if (!force && latest) {
      if (modsets.sameSet(latest.mods, mods)) return null;
      if (now.getTime() - latest.ts < SNAP_MIN_GAP_MS) return null;
    }
    const id = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    const snap = { id, ts: now.getTime(), reason: String(reason || 'snapshot').slice(0, 200), mods };
    const user = config.lgsmUser || 'vhserver';
    const d = snapDir();
    const script = [
      'set -e',
      `d=${shq(d)}`,
      'mkdir -p "$d"',
      `printf '%s' ${shq(Buffer.from(JSON.stringify(snap), 'utf8').toString('base64'))} | base64 -d > "$d/${id}.json"`,
      `chown -R ${shq(`${user}:${user}`)} "$d" 2>/dev/null || true`,
      `ls -1 "$d" | grep -E '^[0-9]{8}-[0-9]{6}\\.json$' | sort | head -n -${SNAP_KEEP} | while read f; do rm -f "$d/$f"; done`,
      'echo SNAPSHOT_OK',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    return r.stdout.includes('SNAPSHOT_OK') ? snap : null;
  } catch (e) {
    return null;
  }
}

async function readBackupModSets() {
  const d = config.paths.backupDir;
  if (!d) return [];
  const r = await sshExec(
    `cd ${shq(d)} 2>/dev/null && for f in $(ls -1t | grep -E -- '-mods\\.txt$' | head -30); do echo "@@@$f $(stat -c %Y "$f")"; cat "$f"; echo; done; true`
  );
  const out = [];
  for (const b of parseBlocks(r.stdout)) {
    const [file, mtime] = b.header.split(' ');
    if (!BACKUP_MODS_RE.test(file || '')) continue;
    try {
      const j = JSON.parse(b.body);
      if (j && Array.isArray(j.folders)) out.push({ file, ts: (parseInt(mtime, 10) || 0) * 1000, mods: modsets.entriesFromFolders(j.folders, j.installedFrom || {}) });
    } catch (e) {}
  }
  return out;
}

async function loadHistoryTarget(id) {
  if (id.startsWith('snap:')) {
    const sid = id.slice(5);
    if (!SNAP_ID_RE.test(sid)) return null;
    const s = (await readSnapshots()).find((x) => x.id === sid);
    return s ? { label: s.reason, ts: s.ts, mods: s.mods } : null;
  }
  if (id.startsWith('backup:')) {
    const file = id.slice(7);
    if (!BACKUP_MODS_RE.test(file)) return null;
    const b = (await readBackupModSets()).find((x) => x.file === file);
    return b ? { label: `Backup ${file.replace(/-mods\.txt$/, '')}`, ts: b.ts, mods: b.mods } : null;
  }
  return null;
}

app.get('/api/mods/history', async (req, res) => {
  try {
    const [snaps, backups] = await Promise.all([readSnapshots(), readBackupModSets().catch(() => [])]);
    const items = [
      ...snaps.map((s) => ({ id: `snap:${s.id}`, kind: 'snapshot', ts: s.ts, reason: s.reason, count: s.mods.length })),
      ...backups.map((b) => ({ id: `backup:${b.file}`, kind: 'backup', ts: b.ts, reason: `Nightly backup ${b.file.replace(/-mods\.txt$/, '')}`, count: b.mods.length })),
    ].sort((a, b) => b.ts - a.ts);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mods/snapshot', async (req, res) => {
  const reason = String((req.body && req.body.reason) || 'Saved manually').slice(0, 200);
  const snap = await takeModSnapshot(reason, { force: true });
  if (!snap) return res.status(500).json({ error: 'Could not save the snapshot (check the plugins folder path and the game account).' });
  res.json({ ok: true, id: `snap:${snap.id}`, count: snap.mods.length });
});

// What getting from the installed mods to a saved set would involve, with packages looked up so the
// client can install them straight away. ?id=snap:<id> or backup:<file>
app.get('/api/mods/restore-plan', async (req, res) => {
  const id = String(req.query.id || '');
  try {
    const target = await loadHistoryTarget(id);
    if (!target) return res.status(404).json({ error: 'That snapshot no longer exists.' });
    const [current, thunderstore, hexium, enforcerCfg, overridesByGuid, dllsByFolder] = await Promise.all([
      captureModSet(),
      packageCache.getThunderstorePackages().catch(() => []),
      modCatalog.getHexiumPackages().catch(() => []),
      modData.loadEnforcerConfig().catch(() => null),
      modData.loadOverrides().catch(() => ({})),
      modData.loadDllsByFolder().catch(() => ({})),
    ]);
    const lists = { thunderstore, hexium };
    const checked = thunderstore.length + hexium.length > 0;
    const find = (src, owner, name) => (lists[src] || []).find((p) => modgraph.norm(p.owner) === modgraph.norm(owner) && modgraph.norm(p.name) === modgraph.norm(name));
    const plan = modsets.planRestore(current, target.mods);
    const lines = plan.lines.map((l) => {
      if (l.action === 'manual') return { ...l, note: 'Hand-named folder, so it cannot be reinstalled from here.' };
      if (l.action === 'remove') {
        const { status } = modData.classifyMod(l.folder, enforcerCfg, overridesByGuid, dllsByFolder[l.folder] || []);
        return { ...l, status, protected: status === 'required' || status === 'adminOnly' };
      }
      if (!checked) return { ...l, source: l.source || 'thunderstore', unchecked: true };
      const order = l.source === 'hexium' ? ['hexium', 'thunderstore'] : ['thunderstore', 'hexium'];
      let pkgFound = null;
      for (const src of order) {
        const p = find(src, l.owner, l.name);
        if (!p) continue;
        pkgFound = { src, p };
        if ((p.versions || []).some((v) => v.version_number === l.version)) return { ...l, source: src, owner: p.owner, name: p.name };
      }
      return { ...l, action: 'manual', note: pkgFound ? `Version ${l.version} is no longer published.` : 'Not found on Thunderstore or Hexium.' };
    });
    res.json({ label: target.label, ts: target.ts, lines, unchanged: plan.unchanged, checked });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What removing these installed mods would affect: other installed mods that need them, and the
// libraries they need (with who else still needs each). ?names=A,B
app.get('/api/mods/remove-plan', async (req, res) => {
  const names = String(req.query.names || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!names.length) return res.status(400).json({ error: 'missing names' });
  try {
    const [lsr, recs, thunderstore, hexium] = await Promise.all([
      sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`),
      modData.loadInstalledFrom().catch(() => ({})),
      packageCache.getThunderstorePackages().catch(() => []),
      modCatalog.getHexiumPackages().catch(() => []),
    ]);
    const folders = lsr.stdout.split('\n').filter(Boolean);
    const nodes = modgraph.buildGraph(folders, recs, { thunderstore, hexium });
    res.json({ ...modgraph.planRemoval(nodes, names.filter((n) => folders.includes(n))), checked: thunderstore.length + hexium.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mods/install', async (req, res) => {
  const { namespace, name, version, packageName, source } = req.body;
  if (!namespace || !name || !version) return res.status(400).json({ error: 'missing fields' });
  const src = source === 'hexium' ? 'hexium' : 'thunderstore';
  const sourceLabel = src === 'hexium' ? 'Hexium' : 'Thunderstore';
  await takeModSnapshot(`Before installing ${namespace}-${packageName || name} ${version}`);
  // `name` is the LOCAL FOLDER to write into (preserved as-is so updating a
  // mod overwrites its existing folder, whatever it's called). `packageName`
  // is the actual package slug for the download URL — these can differ,
  // e.g. a mod originally installed with an "Owner-PackageName" folder
  // convention. Conflating them (using `name` for both) built a
  // doubly-prefixed, nonexistent URL for exactly that case — curl -f then
  // failed instantly and silently, which looked identical to a hang since
  // nothing downstream ever got a chance to print an error.
  const pkgName = packageName || name;
  const downloadUrl = modCatalog.buildDownloadUrl(src, namespace, pkgName, version);
  const tmp = `/tmp/modinstall_${name}_$$`;

  // Keep the version in the folder name current on updates. A folder written
  // as "Owner-Package-<oldVersion>" (the fresh-install convention, see
  // app.js) is renamed to "Owner-Package-<newVersion>" when it's updated, so
  // the folder no longer keeps advertising a stale version (which also
  // misled generate-codes.py's strict folder-name parse). Only renames when
  // the folder's prefix is exactly this package's Owner-Package (never a
  // hand-named or differently-owned folder) and its version suffix differs,
  // and never when a Mods.overrides.yaml folderName pin points at the old
  // name (renaming would silently break that pin). Files are moved, not
  // re-created, so anything a mod keeps inside its own folder survives.
  let finalName = name;
  const verSuffix = name.match(/^(.+)-(\d+(?:\.\d+){1,3})$/);
  if (verSuffix && verSuffix[2] !== version && verSuffix[1].toLowerCase() === `${namespace}-${pkgName}`.toLowerCase()) {
    let pinned = false;
    try {
      const ovr = await modData.loadOverrides();
      pinned = Object.values(ovr || {}).some((o) => o && o.folderName && modData.normalize(o.folderName) === modData.normalize(name));
    } catch (e) {
      pinned = true; // can't tell — safer to keep the old folder name
    }
    if (!pinned) finalName = `${verSuffix[1]}-${version}`;
  }
  const plug = config.paths.pluginsDir;
  const cmd = [
    `\\rm -rf ${shq(tmp)}`,
    `mkdir -p ${shq(tmp)}`,
    // No -f here (unlike before): curl -f fails silently on a bad URL with
    // zero output, which skipped every diagnostic check below it. Without
    // -f, a 404/error page still gets saved to mod.zip, and our own checks
    // (empty file, not a real zip) catch it with an actual clear message.
    `curl -sL --connect-timeout 15 --max-time 120 -w "HTTP_STATUS:%{http_code}\\n" ${shq(downloadUrl)} -o ${shq(tmp)}/mod.zip`,
    `if [ ! -s ${shq(tmp)}/mod.zip ]; then echo "[error] downloaded file is empty — check ${namespace}/${pkgName}/${version} actually exists on ${sourceLabel} (URL: ${downloadUrl})"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `if ! head -c 2 ${shq(tmp)}/mod.zip | grep -q PK; then echo "[error] downloaded file is not a valid zip — ${sourceLabel} returned something else for this namespace/name/version combo (URL: ${downloadUrl})"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // unzip's own exit codes: 0 = clean, 1 = WARNINGS ONLY (extraction still
    // succeeded — e.g. "appears to use backslashes as path separators",
    // common for a mod zipped on Windows), 2+ = a real failure. Every other
    // step in this chain is joined with `&&`, so without this check a mere
    // warning (exit 1) silently aborted the whole install right here — curl
    // had already succeeded, unzip had already extracted the mod correctly,
    // but the plugin folder never got copied into place and no [error] ever
    // printed, because everything after this line simply never ran. Real
    // case: ValheimModding-Jotunn's zip triggers exactly this warning.
    `cd ${shq(tmp)} && unzip -oq mod.zip -d extracted; UNZIP_EC=$?; cd - >/dev/null; ` +
      `if [ "$UNZIP_EC" -gt 1 ]; then echo "[error] unzip exited with code $UNZIP_EC — the downloaded file is likely corrupt or not a valid zip"; \\rm -rf ${shq(tmp)}; exit 1; fi; ` +
      `if [ "$UNZIP_EC" -eq 1 ]; then echo "[note] unzip reported warnings (exit 1, e.g. backslash path separators) — extraction still succeeded, continuing"; fi`,
    `if [ -z "$(ls -A ${shq(tmp)}/extracted 2>/dev/null)" ]; then echo "[error] zip extracted but contained nothing"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // Some Thunderstore packages mirror BepInEx's own layout inside the zip
    // (a top-level plugins/ folder, sometimes alongside config/ or
    // patchers/), rather than putting the DLL at the zip root. Flatten that
    // one level so the mod's files always land directly in its own folder —
    // matches how the majority of mods are packaged and avoids a spurious
    // nested plugins/ folder inside plugins/<name>/.
    // Some Thunderstore packages mirror BepInEx's own layout inside the zip
    // (a top-level plugins/ folder, sometimes alongside config/ or
    // patchers/), rather than putting the DLL at the zip root. Merge that
    // plugins/ subfolder's contents UP into the top level rather than
    // discarding everything else — keeps manifest.json/README/icon etc.
    // alongside the actual plugin files, just without the extra nesting.
    `if [ -d ${shq(tmp)}/extracted/plugins ]; then \\cp -rf ${shq(tmp)}/extracted/plugins/. ${shq(tmp)}/extracted/ && \\rm -rf ${shq(tmp)}/extracted/plugins; fi`,
    finalName !== name
      ? `if [ -d ${shq(plug)}/${shq(name)} ]; then if [ -e ${shq(plug)}/${shq(finalName)} ]; then \\cp -rf ${shq(plug)}/${shq(name)}/. ${shq(plug)}/${shq(finalName)}/ && \\rm -rf ${shq(plug)}/${shq(name)}; else \\mv -f ${shq(plug)}/${shq(name)} ${shq(plug)}/${shq(finalName)}; fi; echo "[note] renamed folder ${name} -> ${finalName}"; fi`
      : `true`,
    `mkdir -p ${shq(config.paths.pluginsDir)}/${shq(finalName)}`,
    // \cp bypasses any `alias cp='cp -i'` (a common root .bashrc default on
    // many VPS images) — without this, overwriting an existing file (i.e.
    // every update, since install always into an empty folder) would hang
    // forever waiting for a y/n prompt that has no terminal to answer it.
    `\\cp -rf ${shq(tmp)}/extracted/* ${shq(config.paths.pluginsDir)}/${shq(finalName)}/`,
    `\\rm -rf ${shq(tmp)}`,
    // The SSH connection runs as root (config.ssh.username), so every file
    // just written above is root-owned. LGSM actively checks file
    // ownership before it'll start the game process and refuses outright
    // ("Ownership issues found") if anything under serverfiles isn't owned
    // by the game-server account — real failure hit in production the
    // first time a mod was installed/updated through the GUI after moving
    // to LGSM. `|| true` so a chown hiccup (e.g. a stray permission quirk)
    // doesn't fail the whole install after the mod files themselves already
    // landed correctly.
    // Zips can carry odd permission bits (a directory without read/execute,
    // root-only modes) that unzip preserves. Even after the chown below, LGSM's
    // ownership check (a `find` run as the game user) then fails with
    // "Permission denied" on that folder and refuses to start the server
    // (real case: momos3939-TameCraft). Normalize: owner read/write, everyone
    // read, directories searchable.
    `chmod -R u+rwX,go+rX ${shq(config.paths.pluginsDir)}/${shq(finalName)} || true`,
    `chown -R ${shq(config.lgsmUser || 'vhserver')}:${shq(config.lgsmUser || 'vhserver')} ${shq(config.paths.pluginsDir)}/${shq(finalName)} || true`,
    // Success marker deliberately keeps the name the CLIENT sent (the
    // frontend matches on `INSTALLED <name> <version>`), even when the folder
    // was just renamed to finalName above.
    `echo INSTALLED ${name} ${version}`,
  ].join(' && ');
  sshExecPlainStream(cmd, res, (code) => {
    // Record exactly which source+package+version this folder was just
    // populated from — see saveInstalledFrom() in mod-data.js. Runs after res has
    // already ended (fire-and-forget), and only on a genuine success (the
    // command chain above `exit 1`s on every failure path, so a non-zero
    // code here means the install/update did NOT actually complete).
    if (code === 0) {
      modData.saveInstalledFrom(finalName, { source: src, owner: namespace, name: pkgName, version }, name).catch((e) => {
        console.error(`[installedFrom] failed to record install source for '${name}':`, e.message);
      });
    }
  });
});

// Sends ONE Discord message summarizing every change since the person last
// clicked "Notify Discord" — installs, updates, removes, and now also
// player/admin code generation, however many happened in between. No
// per-action auto-notify; the GUI collects changes client-side and calls
// this once, on request, specifically to avoid one-message-per-action spam.
// Recategorizations aren't included — moving a mod between
// required/admin/server buckets is internal bookkeeping players have no
// use for.
app.post('/api/mods/notify-summary', async (req, res) => {
  const { changes } = req.body;
  if (!Array.isArray(changes) || !changes.length) return res.json({ ok: true, skipped: true });

  const groups = { install: [], update: [], remove: [], disable: [], enable: [], codes: [] };
  changes.forEach((c) => {
    if (groups[c.type]) groups[c.type].push(c);
  });

  const sections = [];
  if (groups.install.length) {
    sections.push(`**Installed:**\n${groups.install.map((c) => `• ${c.name} v${c.version}`).join('\n')}`);
  }
  if (groups.update.length) {
    sections.push(`**Updated:**\n${groups.update.map((c) => `• ${c.name} → v${c.version}`).join('\n')}`);
  }
  if (groups.remove.length) {
    sections.push(`**Removed:**\n${groups.remove.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.disable.length) {
    sections.push(`**Disabled:**\n${groups.disable.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.enable.length) {
    sections.push(`**Re-enabled:**\n${groups.enable.map((c) => `• ${c.name}`).join('\n')}`);
  }
  if (groups.codes.length) {
    sections.push(
      `**Codes generated:**\n${groups.codes.map((c) => `• ${c.name}: \`${c.code}\``).join('\n')}\nUse Gale Mod Manager when importing codes: File > Import profile > From code.`
    );
  }
  if (!sections.length) return res.json({ ok: true, skipped: true });
  if (!changesWebhook()) {
    return res.json({ ok: false, error: 'No "changes" Discord webhook is set. Add one in Settings, then Discord notifications.' });
  }

  const brand = (await worldInfo.getWorldInfo()).brand;
  const sent = await notifyDiscord(`🛠️ **${brand} mod changes** (${changes.length} total):\n\n${sections.join('\n\n')}`);
  res.json({ ok: sent, error: sent ? undefined : 'Discord rejected the message or was unreachable — check the webhook URL and server logs.' });
});

app.post('/api/mods/remove', async (req, res) => {
  const { name, force } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });

  let enforcerCfg = null;
  try {
    enforcerCfg = await modData.loadEnforcerConfig();
  } catch (e) {}
  const [overridesByGuid, dllsByFolder] = await Promise.all([modData.loadOverrides(), modData.loadDllsByFolder()]);
  const { status, reason } = modData.classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
  const blocked = status === 'required' || status === 'adminOnly';

  if (blocked && !force) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `[blocked] "${name}" is ${status === 'required' ? 'REQUIRED' : 'ADMIN-ONLY'} in ValheimEnforcer.\n` +
        `${reason}\n` +
        `Removing this will lock players out (or yourself, if you're not on the admin list) until it's ` +
        `also taken out of Mods.yaml or the config is regenerated.\n` +
        `Not removed. Resend with force to override.`
    );
    return;
  }

  await takeModSnapshot(`Before removing ${name}`);
  const warn = blocked ? `echo "[WARNING] removed a ${status} mod despite the enforcer check" && ` : '';
  const removeFolderCmd = `rm -rf ${shq(config.paths.pluginsDir)}/${shq(name)} && echo REMOVED ${name}`;

  // After deleting the plugin folder, also clean up its entry in Mods.yaml
  // (if it has one — a mod removed before its first restart never got one).
  // Wrapped so a "no entry found" result reads as informational, not a
  // failure of the removal itself, which already succeeded by this point.
  const yamlCleanupCmd = config.paths.moveModScript
    ? `(python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(name)} delete || echo "[note] no Mods.yaml entry found for '${name}' — nothing to clean up there")`
    : `echo "[note] paths.moveModScript not set — Mods.yaml entry (if any) was NOT cleaned up, only the plugin folder"`;

  sshExecPlainStream(`${warn}${removeFolderCmd} && ${yamlCleanupCmd}`, res);
});

// Disable: pulls the plugin folder OUT of BepInEx/plugins entirely (not into
// a subfolder inside it — BepInEx scans plugins recursively, so a hidden
// subfolder would still get loaded) and moves its Mods.yaml entry to
// optionalMods. optionalMods is the only bucket where both "client has it"
// and "client doesn't" are allowed — required or admin-only would each
// wrongly reject one side or the other for a mod the server no longer runs.
app.post('/api/mods/disable', async (req, res) => {
  const { name, force } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (!config.paths.disabledModsDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.disabledModsDir is not set in config.json.');
  }

  let enforcerCfg = null;
  try {
    enforcerCfg = await modData.loadEnforcerConfig();
  } catch (e) {}
  const [overridesByGuid, dllsByFolder] = await Promise.all([modData.loadOverrides(), modData.loadDllsByFolder()]);
  const { status, reason } = modData.classifyMod(name, enforcerCfg, overridesByGuid, dllsByFolder[name] || []);
  const blocked = status === 'required' || status === 'adminOnly';

  if (blocked && !force) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `[blocked] "${name}" is ${status === 'required' ? 'REQUIRED' : 'ADMIN-ONLY'} in ValheimEnforcer.\n${reason}\n` +
        `Disabling it stops the server from running it, which can break anything that depends on it, or (until the ` +
        `Mods.yaml move below takes effect) mis-enforce who can connect.\n` +
        `Not disabled. Resend with force to override.`
    );
    return;
  }

  const warn = blocked ? `echo "[WARNING] disabling a ${status} mod despite the enforcer check" && ` : '';
  const lgsmUser = shq(config.lgsmUser || 'vhserver');
  const moveFolderCmd =
    // `mkdir -p` here runs as root (the SSH user) — if disabledModsDir
    // doesn't exist yet, this creates it root-owned, which trips LGSM's
    // ownership check on the next start same as the /api/mods/install fix
    // above. chown it every time (cheap, idempotent) rather than only on
    // first creation.
    `mkdir -p ${shq(config.paths.disabledModsDir)} && chown -R ${lgsmUser}:${lgsmUser} ${shq(config.paths.disabledModsDir)} && ` +
    `\\mv -f ${shq(config.paths.pluginsDir)}/${shq(name)} ${shq(config.paths.disabledModsDir)}/${shq(name)} && echo DISABLED ${name}`;
  const yamlMoveCmd = config.paths.moveModScript
    ? `(python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(name)} optional || echo "[note] no Mods.yaml entry found for '${name}' — nothing to recategorize")`
    : `echo "[note] paths.moveModScript not set — Mods.yaml entry (if any) was NOT moved to optional"`;

  sshExecPlainStream(`${warn}${moveFolderCmd} && ${yamlMoveCmd}`, res);
});

app.post('/api/mods/enable', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'missing name' });
  if (!config.paths.disabledModsDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.disabledModsDir is not set in config.json.');
  }
  const cmd =
    `\\mv -f ${shq(config.paths.disabledModsDir)}/${shq(name)} ${shq(config.paths.pluginsDir)}/${shq(name)} && echo ENABLED ${name}` +
    ` && echo "[note] stop and start the server for ValheimEnforcer to detect it again, then set its category from the Mods tab if it shouldn't just be Required"`;
  sshExecPlainStream(cmd, res);
});

app.get('/api/mods/disabled', async (req, res) => {
  if (!config.paths.disabledModsDir) return res.json({ mods: [] });
  try {
    const r = await sshExec(`mkdir -p ${shq(config.paths.disabledModsDir)} && ls -1 ${shq(config.paths.disabledModsDir)} 2>/dev/null`);
    res.json({ mods: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generates player/admin Thunderstore codes DIRECTLY from Mods.yaml — no
// master r2modman profile needed at all. Runs generate-codes.py, which does
// hash verification, thunderstorePackage pin support, and the
// always-included framework packages (BepInExPack/JsonDotNET)
// under the hood. Also passes --plugins-dir so generate-codes.py can resolve
// a mod's real package identity directly from its installed BepInEx/plugins
// folder name (fixes cases like AzuAntiArthriticCrafting/AAA_Crafting, where
// Mods.yaml's cosmetic name has no relationship to the real package name —
// see the --plugins-dir docs at the top of generate-codes.py). Streams
// progress + the resulting code(s).
app.get('/api/mods/generate-codes', async (req, res) => {
  const mode = req.query.mode || 'both'; // player | admin | both
  const dryRun = req.query.dryRun === 'true';
  if (!['player', 'admin', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be player, admin, or both' });
  }
  if (!config.paths.generateCodesScript) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] paths.generateCodesScript is not set in config.json.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  const flag = dryRun ? ' --dry-run' : '';
  const pluginsDirFlag = config.paths.pluginsDir ? ` --plugins-dir ${shq(config.paths.pluginsDir)}` : '';
  // Profile label shown in Gale ("<world> (Player)"): the world's own name, or plain "Valheim" before it exists.
  let label = 'Valheim';
  try { label = (await worldInfo.getWorldInfo()).brand || 'Valheim'; } catch (e) { /* keep the default */ }
  const cmd = `python3 ${shq(config.paths.generateCodesScript)} ${shq(config.paths.enforcerYaml)} --mode ${shq(mode)}${pluginsDirFlag} --profile-name ${shq(label)}${flag}`;
  sshExecStream(cmd, res);
});

// Read-only reference for players: current Required/Optional mods straight
// from Mods.yaml, with a best-effort mod-page link (checked across BOTH
// Thunderstore and Hexium — same fuzzy name matching used for
// update-checking) plus a Gale deep link (gale://install/...) that installs
// the exact mod+version in one click if the player has Gale installed. This
// is what replaces the old r2modman-profile-code distribution flow — Gale
// supports both sources, so this reference list plus its deep links now
// covers a Hexium-only mod exactly as well as a Thunderstore one.
app.get('/api/mods/requirements', async (req, res) => {
  try {
    const enforcerCfg = await modData.loadEnforcerConfig();
    if (!enforcerCfg) return res.json({ required: [], optional: [] });

    let thunderstorePkgs = [];
    let hexiumPkgs = [];
    try {
      [thunderstorePkgs, hexiumPkgs] = await Promise.all([packageCache.getThunderstorePackages(), modCatalog.getHexiumPackages()]);
    } catch (e) {
      // Link lookup is best-effort — still return the list without links.
    }
    const overridesByGuid = await modData.loadOverrides();
    // A thunderstorePackage/hexiumPackage override (Mods.overrides.yaml —
    // never the Mods.yaml entry itself, see loadOverrides()) beats the
    // cosmetic-name-only match below — it names the exact package a human
    // has already verified, so it can't land on an unrelated same-or-
    // similar-named package the way name-only matching can.
    const findMatch = (entry, guid) => {
      const override = overridesByGuid[guid] || {};
      const pinTs = override.thunderstorePackage;
      if (pinTs) {
        const { owner, name } = modCatalog.parseDependencyString(pinTs);
        const ownerNorm = modData.normalize(owner);
        const nameNorm = modData.normalize(name);
        const pinMatch = thunderstorePkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === ownerNorm && modData.normalize(p.name) === nameNorm);
        if (pinMatch) return { source: 'thunderstore', namespace: pinMatch.owner, name: pinMatch.name };
      }
      const pinHex = override.hexiumPackage;
      if (pinHex) {
        const { owner, name } = modCatalog.parseDependencyString(pinHex);
        const ownerNorm = modData.normalize(owner);
        const nameNorm = modData.normalize(name);
        const pinMatch = hexiumPkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === ownerNorm && modData.normalize(p.name) === nameNorm);
        if (pinMatch) return { source: 'hexium', namespace: pinMatch.owner, name: pinMatch.name };
      }

      const nameNorm = modData.normalize(entry.name);
      if (!nameNorm) return null;
      const tsMatch = thunderstorePkgs.find((p) => !p.is_deprecated && modData.normalize(p.name) === nameNorm);
      if (tsMatch) return { source: 'thunderstore', namespace: tsMatch.owner, name: tsMatch.name };
      const hexMatch = hexiumPkgs.find((p) => !p.is_deprecated && modData.normalize(p.name) === nameNorm);
      if (hexMatch) return { source: 'hexium', namespace: hexMatch.owner, name: hexMatch.name };
      return null;
    };
    const listBucket = (bucket) =>
      Object.entries(bucket || {}).map(([guid, entry]) => {
        const match = findMatch(entry, guid);
        return {
          name: entry.name || '(unknown)',
          version: entry.version || '',
          source: match ? match.source : null,
          link: match ? modCatalog.modPageUrl(match.source, match.namespace, match.name) : null,
          galeLink: match && entry.version ? modCatalog.galeInstallLink(match.source, match.namespace, match.name, entry.version) : null,
        };
      });

    res.json({
      required: listBucket(enforcerCfg.requiredMods),
      optional: listBucket(enforcerCfg.optionalMods),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Moves a mod between requiredMods/optionalMods/adminOnlyMods/serverOnlyMods
// in Mods.yaml by shelling out to move-mod.py (which does the actual
// comment-preserving YAML edit + backup). This is what replaces manually
// cutting/pasting a mod's entry after ValheimEnforcer auto-adds it.
app.post('/api/mods/categorize', (req, res) => {
  const { query, bucket } = req.body;
  const allowed = ['required', 'optional', 'admin', 'server'];
  if (!query || !bucket) return res.status(400).json({ error: 'missing query/bucket' });
  if (!allowed.includes(bucket)) return res.status(400).json({ error: `bucket must be one of ${allowed.join(', ')}` });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(query)} ${shq(bucket)}`;
  sshExecPlainStream(cmd, res);
});

// Every known Mods.yaml entry across all four buckets, for the "link to
// existing entry" picker on an Unlisted mod — see /api/mods/pin-folder
// below. A mod shows Unlisted not only when it's genuinely never been
// categorized, but also when it IS correctly in a bucket and the installed
// plugin folder name just doesn't textually resemble the GUID/display name
// (e.g. an acronym like "AAA_Crafting" for "AzuAntiArthriticCrafting") —
// this list is what lets a human pick the right entry instead of hand-
// editing Mods.yaml to add a folderName: pin.
app.get('/api/mods/all-entries', async (req, res) => {
  try {
    const enforcerCfg = await modData.loadEnforcerConfig();
    if (!enforcerCfg) return res.json({ entries: [] });
    const overridesByGuid = await modData.loadOverrides();
    const bucketList = [
      ['required', enforcerCfg.requiredMods],
      ['optional', enforcerCfg.optionalMods],
      ['admin', enforcerCfg.adminOnlyMods],
      ['server', enforcerCfg.serverOnlyMods],
    ];
    const entries = [];
    for (const [bucket, contents] of bucketList) {
      for (const [guid, entry] of Object.entries(contents || {})) {
        entries.push({
          bucket,
          guid,
          name: (entry && entry.name) || guid,
          version: (entry && entry.version) || '',
          // folderName comes from Mods.overrides.yaml now, never the
          // Mods.yaml entry itself — see loadOverrides().
          folderName: (overridesByGuid[guid] && overridesByGuid[guid].folderName) || '',
        });
      }
    }
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pins an installed plugin folder name to an existing Mods.yaml entry, so
// findEnforcerEntry() can match it going forward without relying on fuzzy
// substring matching. Doesn't move the entry between buckets — purely a
// name-matching fix, so (like /api/mods/categorize) this is internal
// bookkeeping and isn't logged to the Discord change summary.
app.post('/api/mods/pin-folder', (req, res) => {
  const { guid, folderName } = req.body;
  if (!guid || !folderName) return res.status(400).json({ error: 'missing guid/folderName' });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} pin-folder ${shq(folderName)}`;
  sshExecPlainStream(cmd, res);
});

// Sets/clears the ignoreUpdates flag on a Mods.yaml entry, so a mod that
// keeps flagging a real but uninteresting/unwanted "update available" (e.g.
// ValheimModding-YamlDotNet's detector plugin, which always reports a stale
// bundled-assembly version — investigated and confirmed genuine, just not
// something worth being reminded about) can be silenced without editing
// Mods.yaml by hand. Like categorize/pin-folder, this is internal
// bookkeeping — not logged to the Discord change summary.
app.post('/api/mods/ignore-updates', (req, res) => {
  const { query, ignore } = req.body;
  if (!query || typeof ignore !== 'boolean') return res.status(400).json({ error: 'missing query/ignore (boolean)' });
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const target = ignore ? 'ignore-updates' : 'unignore-updates';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(query)} ${shq(target)}`;
  sshExecPlainStream(cmd, res);
});

// Pins a Mods.yaml entry's real Thunderstore/Hexium package IDENTITY (owner
// + package name) — for a mod the automatic matcher can't resolve on its
// own: a generic display name matching several unrelated packages, or a
// fork that publishes under a name/owner nothing in Mods.yaml hints at
// (e.g. Valheim Plus's actual current owner being "Grantapher"). The
// `version` field here is NOT frozen into the pin — generate-codes.py
// always resolves the version to actually use from Mods.yaml's own live
// record for this mod (see that script's resolve_entries()), so a pinned
// mod keeps updating normally forever after. It's only required here (and
// by move-mod.py's pin-thunderstore/pin-hexium) to confirm you're pointing
// at a real, currently-published package at the moment you set this.
app.post('/api/mods/pin-package', (req, res) => {
  const { guid, source, owner, packageName, version } = req.body;
  if (!guid || !owner || !packageName || !version || !['thunderstore', 'hexium'].includes(source)) {
    return res.status(400).json({ error: 'missing guid/source/owner/packageName/version' });
  }
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const pinString = `${owner}-${packageName}-${version}`;
  const target = source === 'hexium' ? 'pin-hexium' : 'pin-thunderstore';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} ${target} ${shq(pinString)}`;
  sshExecPlainStream(cmd, res);
});

// Clears a thunderstorePackage/hexiumPackage pin, falling back to the
// normal fuzzy name/hash matching again on the next generate-codes.py run.
app.post('/api/mods/unpin-package', (req, res) => {
  const { guid, source } = req.body;
  if (!guid || !['thunderstore', 'hexium'].includes(source)) {
    return res.status(400).json({ error: 'missing guid/source' });
  }
  if (!config.paths.moveModScript) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.moveModScript is not set in config.json.');
  }
  const target = source === 'hexium' ? 'unpin-hexium' : 'unpin-thunderstore';
  const cmd = `python3 ${shq(config.paths.moveModScript)} ${shq(config.paths.enforcerYaml)} ${shq(guid)} ${target}`;
  sshExecPlainStream(cmd, res);
});
