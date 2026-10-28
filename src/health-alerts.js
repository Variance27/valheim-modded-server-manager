// Health alerts: server down, disk and memory (cron job per world).

const { instSfx, curId, readRegistry, config } = require('./context');
const { statusWebhook } = require('./notify');
const { shq, sshExec, maybeSudo } = require('./exec');
const { app } = require('./app');
const schedules = require('./schedules');
const setup = require('./setup');

// ---- Health alerts: server down, disk and memory (cron job per world; API: /api/health) ----
//
// One small wrapper script per world, run by cron every few minutes whether or not the GUI is open. It
// posts to the status Discord channel. A server stopped from the GUI (or by a backup, update or restore)
// is treated as deliberate. Disk and memory belong to the whole VPS, so only the main world's job checks
// them (otherwise every world would send the same alert).
const HEALTH_INTERVALS = [5, 10, 15, 30, 60];

function healthJob() {
  const sfx = instSfx();
  const idx = curId() === 'main' ? 0 : readRegistry().findIndex((i) => i.id === curId()) + 1;
  return {
    file: `valheim-gui-health${sfx}`,
    script: `valheim-health-check${sfx}.sh`,
    status: `valheim-health-check${sfx}.status`,
    stateBase: `valheim-health${sfx}`,
    minute: (idx * 2 + 3) % 60,
  };
}

function buildHealthWrapper(P, o) {
  const j = healthJob();
  const user = config.lgsmUser || 'vhserver';
  const state = `${P.stateDir}/${j.stateBase}`;
  return [
    '#!/bin/bash',
    '# Managed by valheim-gui. Regenerated every time you save the health alerts.',
    `WEBHOOK=${shq(statusWebhook())}`,
    `LGSM_USER=${shq(user)}`,
    `LGSM_HOME=${shq(config.lgsmHome)}`,
    `STATE=${shq(state)}`,
    `STATUS=${shq(`${P.logDir}/${j.status}`)}`,
    `CHECK_LIVE=${o.live ? 1 : 0}`,
    `CHECK_RES=${o.res ? 1 : 0}`,
    `DISK_WARN=${o.disk}`,
    `MEM_WARN=${o.mem}`,
    'GRACE=120; REALERT=3600',
    `notify() { [ -n "$WEBHOOK" ] && curl -s -m 15 -H "Content-Type: application/json" -d "{\\"content\\":\\"${schedules.worldTag()}$1\\"}" "$WEBHOOK" >/dev/null 2>&1; }`,
    'now=$(date +%s)',
    'problems=""',
    'throttled() { local f="$STATE.$1" last=0; [ -f "$f" ] && last=$(cat "$f" 2>/dev/null || echo 0); if [ $((now - last)) -ge $REALERT ]; then echo "$now" > "$f"; return 0; fi; return 1; }',
    '',
    'if [ "$CHECK_LIVE" = 1 ]; then',
    '  if [ -f "$LGSM_HOME/.maintenance" ] || [ -f "$LGSM_HOME/.stopped-by-gui" ]; then',
    '    rm -f "$STATE.down" "$STATE.live"   # stopped on purpose: nothing to report',
    "  elif pgrep -u \"$LGSM_USER\" -f '^\\./valheim_server\\.x86_64' >/dev/null 2>&1; then",
    '    if [ -f "$STATE.live" ]; then notify "Valheim server is back up. ($(hostname))"; fi',
    '    rm -f "$STATE.down" "$STATE.live"',
    '  else',
    '    [ -f "$STATE.down" ] || echo "$now" > "$STATE.down"',
    '    since=$(cat "$STATE.down" 2>/dev/null || echo "$now")',
    '    if [ $((now - since)) -ge $GRACE ]; then',
    '      problems="$problems server down;"',
    '      throttled live && notify "Valheim server is DOWN: no game process is running and it was not stopped from the GUI. Start it from the GUI or check the log. ($(hostname))"',
    '    fi',
    '  fi',
    'fi',
    '',
    'if [ "$CHECK_RES" = 1 ]; then',
    '  used=$(df --output=pcent "$LGSM_HOME" 2>/dev/null | tail -n1 | tr -dc 0-9)',
    '  if [ -n "$used" ] && [ "$used" -ge "$DISK_WARN" ]; then',
    '    problems="$problems disk ${used}%;"',
    '    throttled disk && notify "Disk usage is high on the VPS: ${used}% used (alert at ${DISK_WARN}%). Lower the backup retention or free some space. ($(hostname))"',
    '  else rm -f "$STATE.disk"; fi',
    "  tot=$(awk '/MemTotal/{print $2}' /proc/meminfo); av=$(awk '/MemAvailable/{print $2}' /proc/meminfo)",
    '  if [ -n "$tot" ] && [ "$tot" -gt 0 ] && [ -n "$av" ]; then',
    '    pct=$((av * 100 / tot))',
    '    if [ "$pct" -le "$MEM_WARN" ]; then',
    '      problems="$problems memory ${pct}% free;"',
    '      throttled mem && notify "Available memory is low on the VPS: ${pct}% free (alert at ${MEM_WARN}%). This can cause out-of-memory crashes; consider more RAM or swap. ($(hostname))"',
    '    else rm -f "$STATE.mem"; fi',
    '  fi',
    'fi',
    '',
    'if [ -z "$problems" ]; then echo "$(date +%s)|ok|All checks passed." > "$STATUS"; else echo "$(date +%s)|fail|Problems:$problems" > "$STATUS"; fi',
    '',
  ].join('\n');
}

function parseHealthSettings(cronText) {
  const m = /# valheim-gui: minutes=(\d+) live=([01]) res=([01]) disk=(\d+) mem=(\d+)/.exec(cronText || '');
  return m ? { enabled: true, minutes: Number(m[1]), live: m[2] === '1', res: m[3] === '1', disk: Number(m[4]), mem: Number(m[5]) } : null;
}

async function readHealthJob() {
  const P = schedules.cronPaths();
  const j = healthJob();
  const r = await sshExec(`cat ${shq(`${P.cronDir}/${j.file}`)} 2>/dev/null; echo ---STATUS---; cat ${shq(`${P.logDir}/${j.status}`)} 2>/dev/null`);
  const [cronText, statusText] = r.stdout.split('---STATUS---');
  const parsed = parseHealthSettings(cronText);
  const out = { enabled: false, minutes: 15, live: true, res: !!config.instance.main, disk: 85, mem: 10, lastRun: null, main: !!config.instance.main, webhookSet: !!statusWebhook(), ...(parsed || {}) };
  const s = (statusText || '').trim().split('|');
  if (s.length >= 3 && /^\d+$/.test(s[0])) out.lastRun = { ts: Number(s[0]) * 1000, ok: s[1] === 'ok', message: s.slice(2).join('|') };
  return out;
}

async function installHealthJob(o) {
  const P = schedules.cronPaths();
  const j = healthJob();
  const cronPath = `${P.cronDir}/${j.file}`;
  const scriptPath = `${P.binDir}/${j.script}`;
  if (!o.enabled) {
    await sshExec(`${maybeSudo(`rm -f ${shq(cronPath)} ${shq(scriptPath)}`)}; echo DONE`);
    return;
  }
  const chk = await sshExec(`[ -d ${shq(P.cronDir)} ] && echo HAVE_CRON_D; (command -v cron || command -v crond) >/dev/null 2>&1 && echo HAVE_CRON`);
  if (!chk.stdout.includes('HAVE_CRON_D') || !chk.stdout.includes('HAVE_CRON')) {
    throw new Error('cron is not installed on the VPS (run: sudo apt install cron && sudo systemctl enable --now cron)');
  }
  await schedules.writeRootFile(scriptPath, buildHealthWrapper(P, o), '700');
  const expr = o.minutes >= 60 ? `${j.minute} * * * *` : `${j.minute % o.minutes}-59/${o.minutes} * * * *`;
  const cron = [
    `# valheim-gui: minutes=${o.minutes} live=${o.live ? 1 : 0} res=${o.res ? 1 : 0} disk=${o.disk} mem=${o.mem}`,
    '# Managed by the valheim-gui dashboard. Edit it there, or delete this file to stop it.',
    'SHELL=/bin/bash',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${expr} root ${scriptPath}`,
    '',
  ].join('\n');
  await schedules.writeRootFile(cronPath, cron, '644');
}

// Every VPS-side file the health job owns (used when a world is uninstalled).
function healthFiles(P, sfx) {
  return [
    `${P.cronDir}/valheim-gui-health${sfx}`,
    `${P.binDir}/valheim-health-check${sfx}.sh`,
    `${P.logDir}/valheim-health-check${sfx}.status`,
    ...['down', 'live', 'disk', 'mem'].map((k) => `${P.stateDir}/valheim-health${sfx}.${k}`),
  ];
}

app.get('/api/health/schedule', async (req, res) => {
  try {
    res.json({ ...(await readHealthJob()), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/health/schedule', async (req, res) => {
  try {
    const b = req.body || {};
    const minutes = Number(b.minutes);
    if (!HEALTH_INTERVALS.includes(minutes)) return res.status(400).json({ error: `minutes must be one of ${HEALTH_INTERVALS.join(', ')}` });
    // Disk and memory are VPS-wide, so only the main world's job uses them; other worlds keep the defaults.
    const checksRes = !!config.instance.main && b.res !== false;
    const disk = checksRes ? Number(b.disk) : 85;
    const mem = checksRes ? Number(b.mem) : 10;
    if (!Number.isInteger(disk) || disk < 50 || disk > 99) return res.status(400).json({ error: 'The disk threshold must be a whole number from 50 to 99 (percent used).' });
    if (!Number.isInteger(mem) || mem < 3 || mem > 50) return res.status(400).json({ error: 'The memory threshold must be a whole number from 3 to 50 (percent still free).' });
    const o = { enabled: !!b.enabled, minutes, live: b.live !== false, res: !!config.instance.main && b.res !== false, disk, mem };
    if (o.enabled && !o.live && !o.res) return res.status(400).json({ error: 'Turn on at least one check.' });
    await installHealthJob(o);
    res.json({ ...(await readHealthJob()), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/health/run', async (req, res) => {
  try {
    const cur = await readHealthJob();
    if (!cur.enabled) return res.status(400).json({ error: 'Turn the health alerts on first.' });
    const P = schedules.cronPaths();
    const j = healthJob();
    await sshExec(setup.asRootScript(`bash ${shq(`${P.binDir}/${j.script}`)}`));
    res.json({ ...(await readHealthJob()), serverTime: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { healthFiles, installHealthJob, readHealthJob });
