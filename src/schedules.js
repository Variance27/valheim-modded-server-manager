// Scheduled backups and update checks: cron files and wrapper scripts on the VPS.

const { config, instSfx, curId, readRegistry } = require('./context');
const { statusWebhook } = require('./notify');
const { shq, maybeSudo, sshExec } = require('./exec');
const { app } = require('./app');

// ---- Scheduled backups + update checks (real cron jobs on the VPS) ----
//
// Saving a schedule in the dashboard installs a cron job in /etc/cron.d plus a
// small wrapper script in /usr/local/bin on the VPS. After that the dashboard
// is not involved at all: cron runs the job whether or not this GUI (or your PC)
// is on. The dashboard only reads the cron file and a status file back to show
// you what is set and how the last run went. Turning a schedule off deletes the
// cron file and the wrapper.
//
// Wrapper behaviour (backup): skipped if the server is stopped (it never starts
// a server you stopped on purpose); with "only when nobody is online" it waits
// up to 1 hour for the server to empty (checking every 10 min) and otherwise
// skips that run; a lock prevents two runs overlapping; failures post to Discord.
const CRON_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 168];
// Prefix for status messages so two worlds' alerts can be told apart in one Discord channel (none for main).
function worldTag() {
  return config.instance.main ? '' : `[${config.instance.label}] `;
}
function cronPaths() {
  const p = config.paths || {};
  return {
    cronDir: p.cronDir || '/etc/cron.d',
    binDir: p.scriptDir || '/usr/local/bin',
    logDir: p.logDir || '/var/log',
    lockDir: p.lockDir || '/var/lock',
    stateDir: p.stateDir || '/var/lib',
  };
}
function cronExpr(hours, minute) {
  if (hours === 168) return `${minute} 4 * * 0`;
  if (hours === 48) return `${minute} 4 */2 * *`;
  if (hours === 1) return `${minute} * * * *`;
  if (hours === 24) return `${minute} 4 * * *`;
  return `${minute} */${hours} * * *`;
}
function describeCron(hours, minute) {
  const mm = String(minute).padStart(2, '0');
  if (hours === 168) return `weekly, Sunday 04:${mm}`;
  if (hours === 48) return `every 2 days at 04:${mm}`;
  if (hours === 1) return `every hour at :${mm}`;
  if (hours === 24) return `daily at 04:${mm}`;
  return `every ${hours} h (at :${mm} past)`;
}

async function writeRootFile(filePath, content, mode) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const cmd = [
    `printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${shq(filePath)}`)} >/dev/null`,
    maybeSudo(`chmod ${mode} ${shq(filePath)}`),
    maybeSudo(`chown root:root ${shq(filePath)}`),
    'echo WROTE',
  ].join(' && ');
  const r = await sshExec(cmd);
  if (!r.stdout.includes('WROTE')) throw new Error(`could not write ${filePath}: ${r.stdout} ${r.stderr}`.trim());
}

// ---- Scheduled jobs: wrapper scripts and cron files ----

function buildBackupWrapper(P, onlyEmpty) {
  const user = config.lgsmUser || 'vhserver';
  const lgsm = config.paths.lgsmScript || `/home/${user}/vhserver`;
  return [
    '#!/bin/bash',
    '# Managed by valheim-gui. Regenerated every time you save the backup schedule.',
    '# Usage: (no args) = the scheduled run; "retry" = run only if an earlier run was postponed.',
    `BACKUP=${shq(config.paths.backupScript)}`,
    `GAMELOG=${shq(config.paths.logFile)}`,
    `LGSM=${shq(lgsm)}`,
    `LGSM_USER=${shq(user)}`,
    `ONLY_EMPTY=${onlyEmpty ? 1 : 0}`,
    `WEBHOOK=${shq(statusWebhook())}`,
    `STATUS=${shq(`${P.logDir}/valheim-scheduled-backup${instSfx()}.status`)}`,
    `LOG=${shq(`${P.logDir}/valheim-scheduled-backup${instSfx()}.log`)}`,
    `PENDING=${shq(`${P.stateDir}/valheim-scheduled-backup${instSfx()}.pending`)}`,
    'MAX_RETRIES=48',
    `exec 9>${shq(`${P.lockDir}/valheim-scheduled-backup${instSfx()}.lock`)}`,
    'flock -n 9 || exit 0',
    'status() { echo "$(date +%s)|$1|$2" > "$STATUS"; }',
    `notify() { [ -n "$WEBHOOK" ] && curl -s -m 15 -H "Content-Type: application/json" -d "{\\"content\\":\\"${worldTag()}$1\\"}" "$WEBHOOK" >/dev/null 2>&1; }`,
    "running() { pgrep -u \"$LGSM_USER\" -f '^\\./valheim_server\\.x86_64' >/dev/null 2>&1; }",
    // Whole log, not just a tail: a busy modded log can push the last "Connections N" line out of a short tail, which would read as "0 players".
    "players() { local n; n=$(grep -aoE 'Connections [0-9]+ ZDOS' \"$GAMELOG\" 2>/dev/null | tail -n1 | grep -oE '[0-9]+'); echo \"${n:-0}\"; }",
    '',
    '# Retry ticks (every 15 min) do nothing unless a previous run was postponed because players were online.',
    'tries=0',
    'if [ "$1" = retry ]; then',
    '  [ -f "$PENDING" ] || exit 0',
    '  tries=$(cat "$PENDING" 2>/dev/null); tries=${tries:-0}',
    '  if [ "$tries" -ge "$MAX_RETRIES" ]; then rm -f "$PENDING"; status skipped "Gave up after $MAX_RETRIES retries (players kept being online); next scheduled run will try again."; exit 0; fi',
    'fi',
    '',
    'if ! running; then rm -f "$PENDING"; status skipped "Server is stopped (a scheduled backup never starts a stopped server)."; exit 0; fi',
    'if [ "$ONLY_EMPTY" = 1 ]; then',
    '  p=$(players)',
    '  if [ "$p" -gt 0 ]; then',
    '    echo $((tries + 1)) > "$PENDING"',
    '    status skipped "Postponed: $p player(s) online. Retrying every 15 min until the server is empty."',
    '    exit 0',
    '  fi',
    'fi',
    '',
    'rm -f "$PENDING"',
    'echo "=== $(date) scheduled backup start ===" >> "$LOG"',
    'bash "$BACKUP" >> "$LOG" 2>&1',
    'rc=$?',
    '# The server was running when we started. If it is not running now (e.g. the backup failed',
    '# after stopping it), bring it back rather than leaving everyone locked out.',
    '# LGSM start returns before the game process is visible; give it up to 90s before deciding it is down.',
    'for _ in $(seq 1 18); do running && break; sleep 5; done',
    'if ! running; then',
    '  echo "=== $(date) server not running after backup (exit $rc) - starting it ===" >> "$LOG"',
    '  su - "$LGSM_USER" -c "\\"$LGSM\\" start" >> "$LOG" 2>&1 9>&-',
    '  sleep 20',
    '  if running; then restarted=" Server was restarted automatically."; else restarted=" SERVER IS STILL DOWN - start it manually."; fi',
    'else',
    '  restarted=""',
    'fi',
    'if [ $rc -eq 75 ]; then',
    '  # backup script reported "busy" (a manual run holds its lock): not a failure, nothing to alert.',
    '  status skipped "Another backup was already running; this scheduled run was skipped."',
    'elif [ $rc -eq 0 ]; then',
    '  status ok "Backup completed.$restarted"',
    '  [ -n "$restarted" ] && notify "Valheim backup finished but the server had stopped.$restarted ($(hostname))"',
    'else',
    '  status fail "Backup failed (exit $rc) - see $LOG.$restarted"',
    '  notify "Scheduled Valheim backup FAILED (exit $rc) on $(hostname).$restarted"',
    'fi',
    '',
  ].join('\n');
}

function buildUpdateWrapper(P) {
  return [
    '#!/bin/bash',
    '# Managed by valheim-gui. Regenerated every time you save the update-check schedule.',
    `CHECK=${shq(config.paths.checkUpdateScript || '')}`,
    `WEBHOOK=${shq(statusWebhook())}`,
    `STATUS=${shq(`${P.logDir}/valheim-update-check${instSfx()}.status`)}`,
    `STATE=${shq(`${P.stateDir}/valheim-update-check${instSfx()}.state`)}`,
    'status() { echo "$(date +%s)|$1|$2" > "$STATUS"; }',
    `notify() { [ -n "$WEBHOOK" ] && curl -s -m 15 -H "Content-Type: application/json" -d "{\\"content\\":\\"${worldTag()}$1\\"}" "$WEBHOOK" >/dev/null 2>&1; }`,
    'out=$(bash "$CHECK" 2>&1 | tail -n 4 | tr "\\n" " " | sed \'s/["\\\\]//g\' | cut -c1-300)',
    "if echo \"$out\" | grep -qiE 'no update|up[- ]to[- ]date|already (on |the )*(latest|newest)'; then",
    '  status ok "Server is up to date."; echo none > "$STATE"',
    "elif echo \"$out\" | grep -qiE 'update available|new version|newer|out ?of ?date|outdated|needs? (an )?update'; then",
    '  status update "Server update available."',
    '  if [ "$(cat "$STATE" 2>/dev/null)" != "$out" ]; then notify "Valheim server update available (nothing was installed or restarted). $out"; echo "$out" > "$STATE"; fi',
    'else',
    '  status ok "Checked. $out"',
    'fi',
    '',
  ].join('\n');
}

// File names of one world's cron job. The main world keeps the original names; every other world gets
// its own set (suffix "-<id>") and a staggered minute so two worlds never stop for a backup together.
function cronJob(kind) {
  const sfx = instSfx();
  const idx = curId() === 'main' ? 0 : readRegistry().findIndex((i) => i.id === curId()) + 1;
  const off = ((idx % 6) * 7) % 60;
  return kind === 'backup'
    ? { file: `valheim-gui-backup${sfx}`, script: `valheim-scheduled-backup${sfx}.sh`, status: `valheim-scheduled-backup${sfx}.status`, minute: (17 + off) % 60 }
    : { file: `valheim-gui-update-check${sfx}`, script: `valheim-update-check${sfx}.sh`, status: `valheim-update-check${sfx}.status`, minute: (47 + off) % 60 };
}

async function readCronJob(kind) {
  const P = cronPaths();
  const j = cronJob(kind);
  const r = await sshExec(`cat ${shq(`${P.cronDir}/${j.file}`)} 2>/dev/null; echo ---STATUS---; cat ${shq(`${P.logDir}/${j.status}`)} 2>/dev/null`);
  const [cronText, statusText] = r.stdout.split('---STATUS---');
  const out = { enabled: false, intervalHours: kind === 'backup' ? 12 : 24, onlyWhenEmpty: true, lastRun: null, description: null, mechanism: 'cron on the VPS' };
  const m = (cronText || '').match(/# valheim-gui: hours=(\d+) onlyEmpty=([01])/);
  if (m) {
    out.enabled = true;
    out.intervalHours = Number(m[1]);
    out.onlyWhenEmpty = m[2] === '1';
    out.description = describeCron(out.intervalHours, j.minute);
  }
  const s = (statusText || '').trim().split('|');
  if (s.length >= 3 && /^\d+$/.test(s[0])) {
    out.lastRun = { ts: Number(s[0]) * 1000, ok: s[1] === 'ok' ? true : s[1] === 'fail' ? false : null, state: s[1], message: s.slice(2).join('|') };
  }
  return out;
}

async function installCronJob(kind, enabled, hours, onlyEmpty) {
  const P = cronPaths();
  const j = cronJob(kind);
  const cronPath = `${P.cronDir}/${j.file}`;
  const scriptPath = `${P.binDir}/${j.script}`;
  if (!enabled) {
    await sshExec(`${maybeSudo(`rm -f ${shq(cronPath)} ${shq(scriptPath)}`)}; echo DONE`);
    return;
  }
  const chk = await sshExec(`[ -d ${shq(P.cronDir)} ] && echo HAVE_CRON_D; (command -v cron || command -v crond) >/dev/null 2>&1 && echo HAVE_CRON`);
  if (!chk.stdout.includes('HAVE_CRON_D') || !chk.stdout.includes('HAVE_CRON')) {
    throw new Error('cron is not installed on the VPS (run: sudo apt install cron && sudo systemctl enable --now cron)');
  }
  if (kind === 'update' && !config.paths.checkUpdateScript) throw new Error('paths.checkUpdateScript is not set in config.json');
  if (kind === 'backup' && !config.paths.backupScript) throw new Error('paths.backupScript is not set in config.json');
  await writeRootFile(scriptPath, kind === 'backup' ? buildBackupWrapper(P, onlyEmpty) : buildUpdateWrapper(P), '700');
  const cron = [
    `# valheim-gui: hours=${hours} onlyEmpty=${onlyEmpty ? 1 : 0}`,
    '# Managed by the valheim-gui dashboard. Edit the schedule there, or delete this file to stop it.',
    'SHELL=/bin/bash',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${cronExpr(hours, j.minute)} root ${scriptPath}`,
    ...(kind === 'backup' ? ['# Retry ticks: only act if the last run was postponed because players were online.', `*/15 * * * * root ${scriptPath} retry`] : []),
    '',
  ].join('\n');
  await writeRootFile(cronPath, cron, '644');
}

function validHours(v) {
  const h = Number(v);
  return CRON_HOURS.includes(h) ? h : null;
}

app.get('/api/backup/schedule', async (req, res) => {
  try {
    res.json({ ...(await readCronJob('backup')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/schedule', async (req, res) => {
  try {
    const { enabled, intervalHours, onlyWhenEmpty } = req.body || {};
    const hours = validHours(intervalHours);
    if (!hours) return res.status(400).json({ error: `intervalHours must be one of ${CRON_HOURS.join(', ')}` });
    await installCronJob('backup', !!enabled, hours, onlyWhenEmpty !== false);
    res.json({ ...(await readCronJob('backup')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/update/schedule', async (req, res) => {
  try {
    res.json({ ...(await readCronJob('update')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/update/schedule', async (req, res) => {
  try {
    const { enabled, intervalHours } = req.body || {};
    const hours = validHours(intervalHours);
    if (!hours) return res.status(400).json({ error: `intervalHours must be one of ${CRON_HOURS.join(', ')}` });
    await installCronJob('update', !!enabled, hours, true);
    res.json({ ...(await readCronJob('update')), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { cronPaths, installCronJob, worldTag, writeRootFile, readCronJob });
