// Removing a world from the VPS, and kept copies of removed worlds.

const fs = require('fs');
const { readRegistry, config, writeRegistry, instanceCtx } = require('./context');
const { shq, sshExec } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const firewall = require('./firewall');
const worldInfo = require('./world-info');
const schedules = require('./schedules');
const healthAlerts = require('./health-alerts');
const bot = require('./bot');
const pending = require('./pending');
const setup = require('./setup');

// ---- Uninstalling a world from the VPS ----
//
// "Remove" can either only forget a world in the GUI, or also delete it from the VPS: stop its
// processes, remove its scheduled jobs and their files, optionally keep a copy of its saves and
// backups, then delete its game account and home folder. Everything is derived from the world's
// registry entry and checked against strict patterns first, and nothing but the account named
// vhserver-<id> (and its own /home/vhserver-<id> folder) can ever be touched. The main world
// cannot be uninstalled from here.
const PURGE_ACCT_RE = /^vhserver-[a-z][a-z0-9]{0,9}$/;
const KEPT_WORLDS_DIR = '/var/lib/valheim-removed-worlds';

async function purgeTarget(entry) {
  const id = entry.id;
  const acct = entry.lgsmUser;
  const mainUser = await worldsPage.inWorld('main', async () => config.lgsmUser);
  if (id === 'main' || !PURGE_ACCT_RE.test(acct) || acct !== `vhserver-${id}` || acct === mainUser) {
    throw new Error(`Refusing to delete: "${acct}" is not a game account this GUI created for an extra world.`);
  }
  if (readRegistry().some((x) => x.id !== id && x.lgsmUser === acct)) throw new Error('Another world uses the same game account; refusing to delete it.');
  const home = `/home/${acct}`;
  const cfgHome = await worldsPage.inWorld(id, async () => config.lgsmHome);
  if (cfgHome !== home) throw new Error(`This world's home folder is ${cfgHome}, not ${home}; refusing to delete anything automatically.`);
  // Where this world's saves live (the same place the rest of the GUI reads them from); only trusted when it is inside the home folder.
  const listDir = await worldsPage.inWorld(id, async () => config.paths.listDir);
  const saveDir = listDir && listDir.startsWith(`${home}/`) && !/[\s'"$`\\;|&<>]/.test(listDir) && !listDir.includes('..') ? listDir : `${home}/.config/unity3d/IronGate/Valheim`;
  return { id, acct, home, saveDir };
}

app.get('/api/instances/:id/uninstall-preview', async (req, res) => {
  try {
    const entry = readRegistry().find((x) => x.id === req.params.id);
    if (!entry) return res.status(404).json({ error: `Unknown world "${req.params.id}"` });
    const t = await purgeTarget(entry);
    const script = [
      `ACCT=${shq(t.acct)}; HOME_DIR=${shq(t.home)}`,
      'getent passwd "$ACCT" >/dev/null 2>&1 && echo "USER:1" || echo "USER:0"',
      '[ -d "$HOME_DIR" ] && echo "SIZE_MB:$(du -sm "$HOME_DIR" 2>/dev/null | cut -f1)" || echo "SIZE_MB:0"',
      'echo "BACKUPS:$(ls -1 "$HOME_DIR/backups" 2>/dev/null | wc -l)"',
      `V=${shq(t.saveDir)}`,
      // A world exists as soon as its .fwl is written (first start); the .db appears after the first save.
      'echo "WORLDS:$(ls -1 "$V/worlds_local" "$V/worlds" 2>/dev/null | grep -E "\\.(db|fwl)$" | sed -E "s/\\.(db|fwl)$//" | sort -u | wc -l)"',
      'echo "SAVED:$(ls -1 "$V/worlds_local" "$V/worlds" 2>/dev/null | grep -E "\\.db$" | sed -E "s/\\.db$//" | sort -u | wc -l)"',
      'echo "PROCS:$(pgrep -u "$ACCT" 2>/dev/null | wc -l)"',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    const get = (k) => Number((new RegExp(`${k}:(\\d+)`).exec(r.stdout) || [])[1] || 0);
    res.json({ account: t.acct, home: t.home, userExists: get('USER') === 1, sizeMB: get('SIZE_MB'), backups: get('BACKUPS'), saves: get('WORLDS'), savedOnce: get('SAVED'), processes: get('PROCS') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Kept copies of deleted worlds (API: /api/kept-worlds) ----
// "Delete, keep a copy" leaves the saves, lists and backups of a deleted world under KEPT_WORLDS_DIR.
// These endpoints list them, restore one into any world, or delete one for good.
const KEPT_NAME_RE = /^[a-z][a-z0-9]{0,9}-\d{14}$/;

app.get('/api/kept-worlds', async (req, res) => {
  try {
    const script = [
      `KEPT=${shq(KEPT_WORLDS_DIR)}`,
      '[ -d "$KEPT" ] || exit 0',
      'for d in "$KEPT"/*/; do',
      '  [ -d "$d" ] || continue',
      '  n=$(basename "$d")',
      `  echo "$n" | grep -Eq '^[a-z][a-z0-9]{0,9}-[0-9]{14}$' || continue`,
      '  size=$(du -sm "$d" 2>/dev/null | cut -f1)',
      '  b=$(ls -1 "$d/backups" 2>/dev/null | wc -l)',
      `  w=$(ls -1 "$d/worlds_local" "$d/worlds" 2>/dev/null | grep -E '\\.(db|fwl)$' | sed -E 's/\\.(db|fwl)$//' | sort -u | paste -sd, -)`,
      '  l=0; for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$d/$f" ] && l=1; done',
      '  echo "ENTRY|$n|${size:-0}|$b|$w|$l"',
      'done',
      'true',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    const items = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^ENTRY\|([^|]+)\|(\d+)\|(\d+)\|([^|]*)\|([01])$/.exec(line.trim());
      if (!m || !KEPT_NAME_RE.test(m[1])) continue;
      const st = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(m[1]);
      items.push({
        name: m[1],
        from: m[1].replace(/-\d{14}$/, ''),
        deletedAt: st ? `${st[1]}-${st[2]}-${st[3]}T${st[4]}:${st[5]}:${st[6]}Z` : null,
        sizeMB: Number(m[2]),
        backups: Number(m[3]),
        worlds: m[4] ? m[4].split(',') : [],
        hasLists: m[5] === '1',
      });
    }
    items.sort((a, b) => (b.name > a.name ? 1 : -1));
    res.json({ dir: KEPT_WORLDS_DIR, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/kept-worlds/restore', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '');
    const target = String(b.target || '');
    if (!KEPT_NAME_RE.test(name)) return res.status(400).json({ error: 'Unknown kept copy.' });
    if (!worldsPage.worldList().includes(target)) return res.status(400).json({ error: `Unknown world "${target}".` });
    const overwrite = b.overwrite === true;
    const lists = b.lists === true;
    const t = await worldsPage.inWorld(target, async () => ({
      user: config.lgsmUser,
      home: config.lgsmHome,
      listDir: config.paths.listDir,
      backupDir: config.paths.backupDir,
      label: config.instance.label,
    }));
    if (!t.user || !/^[a-z_][a-z0-9_-]*$/.test(t.user) || !t.home || !t.listDir || !t.backupDir) return res.status(400).json({ error: 'That world has no game account or save folder yet. Run its Setup first.' });
    if (!t.listDir.startsWith(`${t.home}/`) || /[\s'"$`\;|&<>]/.test(`${t.listDir}${t.backupDir}`) || t.listDir.includes('..')) return res.status(400).json({ error: 'That world uses a save folder this GUI will not write to automatically.' });
    const script = [
      'set -u',
      `SRC=${shq(`${KEPT_WORLDS_DIR}/${name}`)}; V=${shq(t.listDir)}; U=${shq(t.user)}; BK=${shq(t.backupDir)}; OVER=${overwrite ? 1 : 0}; LISTS=${lists ? 1 : 0}`,
      '[ -d "$SRC" ] || { echo "[error] that kept copy no longer exists"; exit 2; }',
      'id -u "$U" >/dev/null 2>&1 || { echo "[error] the game account $U does not exist"; exit 2; }',
      `if pgrep -u "$U" -f '^\\./valheim_server\\.x86_64' >/dev/null 2>&1; then echo "[running] stop this world first"; exit 4; fi`,
      'NEW=0; COLL=""',
      'if [ -d "$SRC/worlds_local" ]; then',
      '  for f in "$SRC"/worlds_local/*; do [ -e "$f" ] || continue; bn=$(basename "$f"); if [ -e "$V/worlds_local/$bn" ]; then COLL="$COLL $bn"; fi; done',
      'fi',
      'if [ -n "$COLL" ] && [ "$OVER" != 1 ]; then echo "[collision]$COLL"; exit 3; fi',
      '[ -d "$SRC/worlds_local" ] || [ -d "$SRC/worlds" ] || [ "$LISTS" = 1 ] || { echo "[error] this kept copy has no world saves"; exit 2; }',
      'mkdir -p "$V/worlds_local" "$BK"',
      'STAMP=$(date +%Y%m%d-%H%M%S)',
      'ITEMS=""',
      '[ -d "$V/worlds_local" ] && [ -n "$(ls -A "$V/worlds_local" 2>/dev/null)" ] && ITEMS="worlds_local"',
      'if [ "$LISTS" = 1 ]; then for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$V/$f" ] && ITEMS="$ITEMS $f"; done; fi',
      'SAFE=""',
      'if [ -n "$ITEMS" ]; then',
      '  SAFE="$BK/PRE-IMPORT-$STAMP.tar.gz"',
      '  tar -czf "$SAFE" -C "$V" $ITEMS && tar -tzf "$SAFE" >/dev/null || { echo "[error] could not make the safety copy; nothing was changed"; exit 5; }',
      '  chown "$U:$U" "$SAFE"; echo "[note] safety copy of what was there: $SAFE"',
      'fi',
      'if [ -d "$SRC/worlds_local" ]; then cp -a "$SRC/worlds_local/." "$V/worlds_local/" || { echo "[error] copy failed"; exit 6; }; fi',
      'if [ -d "$SRC/worlds" ]; then mkdir -p "$V/worlds"; cp -a "$SRC/worlds/." "$V/worlds/" || { echo "[error] copy failed"; exit 6; }; fi',
      'if [ "$LISTS" = 1 ]; then for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$SRC/$f" ] && cp -a "$SRC/$f" "$V/$f"; done; fi',
      'chown -R "$U:$U" "$V/worlds_local" 2>/dev/null; [ -d "$V/worlds" ] && chown -R "$U:$U" "$V/worlds"',
      'if [ "$LISTS" = 1 ]; then for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$V/$f" ] && chown "$U:$U" "$V/$f"; done; fi',
      `NAMES=$(ls -1 "$SRC/worlds_local" "$SRC/worlds" 2>/dev/null | grep -E '\\.(db|fwl)$' | sed -E 's/\\.(db|fwl)$//' | sort -u | paste -sd, -)`,
      'echo "[done] $NAMES"',
      'echo "[safe] $SAFE"',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const coll = /\[collision\]\s*(.*)/.exec(out);
    if (coll) return res.status(409).json({ error: `These already exist in ${t.label}: ${coll[1].trim().split(/\s+/).join(', ')}.`, collision: true, files: coll[1].trim().split(/\s+/) });
    if (/\[running\]/.test(out)) return res.status(409).json({ error: `${t.label} is running. Stop it first.` });
    const done = /\[done\]\s*(.*)/.exec(out);
    if (!done || r.code) return res.status(500).json({ error: out.split('\n').filter((l) => /\[error\]/.test(l)).join(' ') || out.trim() || 'restore failed' });
    const names = done[1].split(',').filter(Boolean);
    const safe = ((/\[safe\]\s*(.*)/.exec(out) || [])[1] || '').trim() || null;
    res.json({ ok: true, target: t.label, worlds: names, safetyCopy: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/kept-worlds/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '');
    if (!KEPT_NAME_RE.test(name)) return res.status(400).json({ error: 'Unknown kept copy.' });
    const script = [
      `KEPT=${shq(KEPT_WORLDS_DIR)}; D="$KEPT/"${shq(name)}`,
      '[ -d "$D" ] || { echo "[error] already gone"; exit 2; }',
      'case "$(readlink -f "$D")" in "$KEPT"/*) rm -rf -- "$D" ;; *) echo "[error] unexpected path"; exit 3 ;; esac',
      '[ -e "$D" ] && { echo "[error] could not delete it"; exit 4; }',
      'echo DELETED',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    if (!r.stdout.includes('DELETED')) return res.status(500).json({ error: (r.stdout + r.stderr).split('\n').filter((l) => /\[error\]/.test(l)).join(' ') || 'could not delete it' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function purgeWorldHost(entry, keepCopy) {
  const t = await purgeTarget(entry);
  const P = schedules.cronPaths();
  const sfx = `-${t.id}`;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const keepDir = `${KEPT_WORLDS_DIR}/${t.id}-${stamp}`;
  const files = [
    `${P.cronDir}/valheim-gui-backup${sfx}`,
    `${P.cronDir}/valheim-gui-update-check${sfx}`,
    `${P.binDir}/valheim-scheduled-backup${sfx}.sh`,
    `${P.binDir}/valheim-update-check${sfx}.sh`,
    `${P.logDir}/valheim-scheduled-backup${sfx}.status`,
    `${P.logDir}/valheim-update-check${sfx}.status`,
    `${P.lockDir}/valheim-scheduled-backup${sfx}.lock`,
    `${P.stateDir}/valheim-scheduled-backup${sfx}.pending`,
    `${P.stateDir}/valheim-update-check${sfx}.state`,
    ...healthAlerts.healthFiles(P, sfx),
  ];
  const script = [
    'set -u',
    `ACCT=${shq(t.acct)}; HOME_DIR=${shq(t.home)}; KEEP=${keepCopy ? 1 : 0}; KEEPDIR=${shq(keepDir)}`,
    'if getent passwd "$ACCT" >/dev/null 2>&1; then',
    '  HAVE_USER=1',
    '  [ "$(getent passwd "$ACCT" | cut -d: -f6)" = "$HOME_DIR" ] || { echo "[error] the account\'s home folder is not $HOME_DIR - refusing to delete anything"; exit 3; }',
    'else',
    '  HAVE_USER=0',
    '  echo "[note] the account $ACCT does not exist (already deleted?)"',
    'fi',
    'if pgrep -u "$ACCT" >/dev/null 2>&1; then',
    '  echo "[step] Stopping the running processes of $ACCT..."',
    '  pkill -u "$ACCT"; sleep 3',
    '  if pgrep -u "$ACCT" >/dev/null 2>&1; then pkill -9 -u "$ACCT"; sleep 1; fi',
    '  pgrep -u "$ACCT" >/dev/null 2>&1 && { echo "[error] processes of $ACCT are still running"; exit 4; }',
    'fi',
    'if [ "$KEEP" = 1 ] && [ -d "$HOME_DIR" ]; then',
    '  echo "[step] Keeping a copy of the saves and backups in $KEEPDIR ..."',
    '  mkdir -p "$KEEPDIR" || { echo "[error] cannot create $KEEPDIR"; exit 6; }',
    `  V=${shq(t.saveDir)}`,
    '  if [ -d "$HOME_DIR/backups" ]; then cp -a "$HOME_DIR/backups" "$KEEPDIR/backups" || { echo "[error] could not copy the backups"; exit 6; }; fi',
    '  if [ -d "$V/worlds_local" ]; then cp -a "$V/worlds_local" "$KEEPDIR/worlds_local" || { echo "[error] could not copy the world saves"; exit 6; }; fi',
    '  if [ -d "$V/worlds" ]; then cp -a "$V/worlds" "$KEEPDIR/worlds" || { echo "[error] could not copy the world saves"; exit 6; }; fi',
    '  for f in adminlist.txt bannedlist.txt permittedlist.txt; do [ -f "$V/$f" ] && cp -a "$V/$f" "$KEEPDIR/"; done',
    '  chmod -R go-rwx "$KEEPDIR"',
    '  if [ -n "$(ls -A "$KEEPDIR" 2>/dev/null)" ]; then echo "[note] copy kept in $KEEPDIR"; else rmdir "$KEEPDIR" 2>/dev/null; echo "[note] nothing to keep: this world had no saves or backups"; fi',
    'fi',
    'echo "[step] Removing scheduled jobs and their files..."',
    'crontab -r -u "$ACCT" >/dev/null 2>&1 || true',
    `rm -f -- ${files.map(shq).join(' ')}`,
    'if [ "$HAVE_USER" = 1 ]; then',
    '  echo "[step] Deleting the game account $ACCT and its home folder..."',
    '  OUT="$(userdel -r -f "$ACCT" 2>&1)"; RC=$?',
    '  getent passwd "$ACCT" >/dev/null 2>&1 && { echo "[error] could not delete the account: $OUT"; exit 5; }',
    '  [ $RC -ne 0 ] && echo "[note] userdel said: $OUT"',
    'fi',
    'if [ -d "$HOME_DIR" ]; then echo "[step] Removing leftover files in $HOME_DIR ..."; rm -rf -- "$HOME_DIR"; fi',
    '[ -d "$HOME_DIR" ] && { echo "[error] $HOME_DIR could not be removed"; exit 7; }',
    'getent group "$ACCT" >/dev/null 2>&1 && groupdel "$ACCT" >/dev/null 2>&1',
    'echo "[done] $ACCT and $HOME_DIR are gone."',
  ].join('\n');
  const r = await sshExec(setup.asRootScript(script));
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.code && r.code !== 0) throw new Error(out.split('\n').filter((l) => /\[error\]/.test(l)).join(' ') || out || `uninstall failed (exit ${r.code})`);
  return { log: out.split('\n').filter(Boolean), keptAt: keepCopy && /copy kept in/.test(out) ? keepDir : null };
}

app.delete('/api/instances/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (id === 'main') return res.status(400).json({ error: 'The main world cannot be removed.' });
    const reg = readRegistry();
    const entry = reg.find((x) => x.id === id);
    if (!entry) return res.status(404).json({ error: `Unknown world "${id}"` });
    const purge = req.query.purge === '1';
    const keep = req.query.keep === '1';
    const sum = await worldsPage.worldSummary(id);
    if (sum.state === 'active') return res.status(409).json({ error: 'Stop this world first.' });
    // Remove its scheduled jobs (best effort).
    await worldsPage.inWorld(id, async () => {
      for (const kind of ['backup', 'update']) {
        try {
          await schedules.installCronJob(kind, false, 0, false);
        } catch (e) {
          /* nothing scheduled */
        }
      }
      try {
        await healthAlerts.installHealthJob({ enabled: false });
      } catch (e) {
        /* nothing scheduled */
      }
    });
    // Uninstalling happens BEFORE the world is forgotten, so a failure leaves it listed and retryable.
    let purged = null;
    let fw = null;
    if (purge) {
      // The port is read BEFORE the world's files are deleted.
      const fwPort = await worldsPage.inWorld(id, () => firewall.worldGamePort()).catch(() => null);
      purged = await worldsPage.inWorld(id, () => purgeWorldHost(entry, keep));
      // Close its UDP range, unless another world's ports overlap it.
      fw = await worldsPage.inWorld(id, async () => {
        if (!fwPort) return null;
        try {
          if ((await worldsPage.otherWorldPorts()).some((o) => worldsPage.portsOverlap(o.port, fwPort))) return { message: `UDP ${firewall.gameRange(fwPort)} was left open because another world uses nearby ports.` };
          return await firewall.fwRun('close', fwPort);
        } catch (e) {
          return { message: `The firewall was not changed: ${e.message}` };
        }
      });
    }
    writeRegistry(reg.filter((x) => x.id !== id));
    bot.syncBotWorlds().catch(() => {});
    instanceCtx.delete(id);
    worldInfo.worldInfoCaches.delete(id);
    try {
      fs.rmSync(pending.pendingFile(id), { force: true });
    } catch (e) {
      /* no pending list */
    }
    const note = purge
      ? `"${entry.label}" was uninstalled: game account ${entry.lgsmUser} and its files were deleted from the VPS.${purged && purged.keptAt ? ` A copy of its saves and backups is in ${purged.keptAt}.` : ''} ${fw && fw.message ? fw.message : 'Check that its UDP ports are closed in your firewall.'}`
      : `"${entry.label}" is no longer managed here. Its game account (${entry.lgsmUser}) and files are still on the VPS.`;
    res.json({ ok: true, purged: !!purge, keptAt: purged ? purged.keptAt : null, log: purged ? purged.log : [], firewall: fw, note });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
