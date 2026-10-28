// Backups: run, list, restore, and world save health.

const { instSfx, config } = require('./context');
const { shq, sshExecStream, maybeSudo, sshExec, asLgsmUser, sshExecPlainStream } = require('./exec');
const { app } = require('./app');
const worldInfo = require('./world-info');
const schedules = require('./schedules');

// ---- Backups ----

app.get('/api/backup/run', (req, res) => {
  // Shares the lock with the scheduled-backup cron job so the two can never run
  // at the same time (exit 99 = the lock is held by a running scheduled backup).
  const lock = `${schedules.cronPaths().lockDir}/valheim-scheduled-backup${instSfx()}.lock`;
  const cmd = `flock -n -E 99 ${shq(lock)} bash ${shq(config.paths.backupScript)}; rc=$?; ` +
    `if [ $rc -eq 99 ]; then echo "A scheduled backup is already running - wait for it to finish, then try again."; fi; exit $rc`;
  sshExecStream(maybeSudo(`bash -c ${shq(cmd)}`), res);
});

app.get('/api/backup/list', async (req, res) => {
  try {
    // Each backup also leaves a <name>-plugins.txt next to it (the mod list at that moment). Text files are
    // records, not something to restore, so they are left out of this list and do not use up the 50 slots.
    const r = await sshExec(`ls -1t ${shq(config.paths.backupDir)} 2>/dev/null | grep -v -e '\\.txt$' | head -50`);
    res.json({ files: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- World save health (API: GET /api/save-health) ----
//
// When did Valheim last write the world to disk? The server only saves on its
// autosave timer (-saveinterval) and on a clean stop, so a gap much longer than
// the interval means progress is only living in memory — exactly the situation
// that produced the "rolled back to day 1" surprise. Reads file times only.
app.get('/api/save-health', async (req, res) => {
  try {
    const { dir, world, parent } = await worldInfo.worldPaths();
    if (!worldInfo.SAFE_WORLD_NAME.test(world)) return res.status(500).json({ error: `The world name "${world}" has characters the GUI does not support (use letters, digits, . _ -)` });
    const user = config.lgsmUser || 'vhserver';
    const flat = `${parent}/Valheim/worlds_local/${world}`;
    const cmd = [
      `PID=$(pgrep -u ${shq(user)} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
      `LAST=$( { find ${shq(dir)} -maxdepth 2 -type f -not -path '*/backups/*' -printf '%T@\\n' 2>/dev/null; ` +
        `stat -c %Y ${shq(flat + '.db')} ${shq(flat + '.fwl')} 2>/dev/null; } | cut -d. -f1 | sort -n | tail -1 )`,
      `INTERVAL=1800`,
      `START=""`,
      `if [ -n "$PID" ]; then ` +
        `START=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
        `I=$(tr '\\0' ' ' < /proc/$PID/cmdline 2>/dev/null | grep -o -- '-saveinterval [0-9]*' | awk '{print $2}'); ` +
        `[ -n "$I" ] && INTERVAL=$I; fi`,
      `echo "RUNNING=$([ -n "$PID" ] && echo 1 || echo 0)"`,
      `echo "LAST=$LAST"`,
      `echo "START=$START"`,
      `echo "INTERVAL=$INTERVAL"`,
      `echo "NOW=$(date +%s)"`,
    ].join('; ');
    const r = await sshExec(cmd);
    const kv = {};
    r.stdout.split('\n').forEach((l) => {
      const i = l.indexOf('=');
      if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    });
    const num = (v) => (v !== undefined && v !== '' && isFinite(+v) ? +v : null);
    const running = kv.RUNNING === '1';
    const last = num(kv.LAST);
    const start = num(kv.START);
    const interval = num(kv.INTERVAL) || 1800;
    const now = num(kv.NOW) || Math.floor(Date.now() / 1000);
    const age = last != null ? Math.max(0, now - last) : null;
    const sinceStart = start != null ? Math.max(0, now - start) : null;

    let state;
    if (!running) state = 'stopped';
    else if (last == null) state = 'unknown'; // no world files found at all
    else if (start != null && last < start && sinceStart <= interval + 180) state = 'waiting'; // first autosave not due yet
    else if (age <= interval + 180) state = 'ok';
    else if (age <= interval * 2 + 180) state = 'late';
    else state = 'stale';

    res.json({
      state,
      running,
      lastSaveTs: last != null ? last * 1000 : null,
      ageSec: age,
      intervalSec: interval,
      serverStartTs: start != null ? start * 1000 : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore: put the world from a chosen backup tarball back, safely.
//
//  1. Verify the archive is readable AND actually contains this world — before
//     anything is stopped or touched.
//  2. Stop the server (a clean stop saves the current world).
//  3. Save a safety copy of the CURRENT world as PRE-RESTORE-<world>-<date>.tar.gz
//     in the backup folder, and verify it. (It shows up in the backup list, so a
//     bad restore can itself be undone.)
//  4. Delete the current world's files, then extract the world from the backup.
//     Deleting first matters: Valheim's newer save format numbers its files
//     (_main.2.db2, _main.4.db2, …) and loads the HIGHEST number, so extracting
//     an older backup over the top would leave the newer save in place and the
//     "restore" would silently do nothing.
//  5. Only the world is restored — mods and BepInEx configs are left as they are.
//     (The old restore also unpacked a stray BepInEx/ folder into the save dir.)
//  6. Fix ownership and start the server.
app.post('/api/backup/restore', async (req, res) => {
  const { file } = req.body || {};
  if (!file || typeof file !== 'string' || !/^[\w.@+-]+\.tar\.gz$/.test(file)) {
    return res.status(400).json({ error: 'missing or invalid backup file name' });
  }
  if (!config.paths.worldDir || !config.paths.backupDir) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('[error] paths.worldDir and paths.backupDir must be set in config.json before restoring.');
  }
  const { parent, world, member, dir } = await worldInfo.worldPaths();
  if (!worldInfo.SAFE_WORLD_NAME.test(world)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`[error] The world name "${world}" has characters the GUI does not support (use letters, digits, . _ -).`);
  }
  const user = config.lgsmUser || 'vhserver';
  const script = config.paths.lgsmScript || `/home/${user}/vhserver`;
  const backupPath = `${config.paths.backupDir}/${file}`;
  const flat = `${parent}/Valheim/worlds_local/${world}`;
  const cmd = [
    `echo "Verifying backup integrity before touching anything..."`,
    `tar -tzf ${shq(backupPath)} > /dev/null`,
    `( tar -tzf ${shq(backupPath)} | grep -qF -e ${shq(member + '/')} -e ${shq(member + '.fwl')} -e ${shq(member + '.db')} || { echo "[error] this archive contains no ${world} world data — refusing to restore"; false; } )`,
    `echo "Backup verified OK."`,
    asLgsmUser(`${shq(script)} stop`),
    `echo "Server stopped (world saved by the stop)."`,
    // Safety copy of what's on disk right now — whichever form the world has (folder, or flat .fwl/.db pair).
    `{ ITEMS=""; if [ -d ${shq(dir)} ]; then ITEMS=${shq(member)}; fi; ` +
      `if [ -f ${shq(flat + '.fwl')} ]; then ITEMS="$ITEMS "${shq(member + '.fwl')}" "${shq(member + '.db')}; fi; ` +
      `if [ -n "$ITEMS" ]; then ` +
      `SAFE=${shq(config.paths.backupDir)}"/PRE-RESTORE-${world}-$(date +%F-%H%M).tar.gz"; ` +
      `tar -czf "$SAFE" -C ${shq(parent)} $ITEMS && tar -tzf "$SAFE" > /dev/null && ` +
      `chown ${shq(user)}:${shq(user)} "$SAFE" && echo "Safety copy of the current world: $SAFE"; fi; }`,
    // Remove the current world's files (guarded so a bad path can never expand to something else).
    `{ case ${shq(dir)} in */worlds_local/?*) rm -rf -- ${shq(dir)}; rm -f -- ${shq(flat + '.db')} ${shq(flat + '.fwl')} ${shq(flat + '.db.old')} ${shq(flat + '.fwl.old')} ;; *) echo "[error] unexpected world path"; false ;; esac; }`,
    `echo "Extracting ${file}..."`,
    `{ tar -xzf ${shq(backupPath)} -C ${shq(parent)} ${shq(member)} 2>/dev/null; tar -xzf ${shq(backupPath)} -C ${shq(parent)} ${shq(member + '.fwl')} ${shq(member + '.db')} 2>/dev/null; ` +
      `if [ -d ${shq(dir)} ] || [ -f ${shq(flat + '.fwl')} ]; then true; else echo "[error] extraction produced no world files — the previous world is in: $SAFE"; false; fi; }`,
    // The world is either a folder (worlds_local/<name>/) or a flat <name>.fwl/.db pair; fix whichever came back.
    `{ if [ -d ${shq(dir)} ]; then chown -R ${shq(user)}:${shq(user)} ${shq(dir)}; fi; }`,
    `{ chown ${shq(user)}:${shq(user)} ${shq(flat + '.db')} ${shq(flat + '.fwl')} 2>/dev/null; true; }`,
    `echo "Extracted. Starting..."`,
    asLgsmUser(`${shq(script)} start`),
    `echo "RESTORED ${file}"`,
    `echo "Previous world kept as: \${SAFE:-none}"`,
  ].join(' && ');
  // The health check stays quiet while a restore has the server down on purpose; the flag is removed however the restore ends.
  const flag = `${config.lgsmHome}/.maintenance`;
  sshExecPlainStream(`${maybeSudo(`touch ${shq(flag)}`)}; { ${cmd}; }; RC=$?; ${maybeSudo(`rm -f ${shq(flag)}`)}; exit $RC`, res);
});
