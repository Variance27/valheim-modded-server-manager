// Project Zomboid tab (optional, `zomboid` block in config.json).

const fs = require('fs');
const path = require('path');
const pzmodsets = require('../pzmodsets');
const { config, ROOT } = require('./context');
const { shq, sshExec, maybeSudo, sshExecStream, sshExecPlainStream, notifyDiscord, sshExecFollow } = require('./exec');
const { app } = require('./app');
const setup = require('./setup');

// Project Zomboid — a second game managed from this same GUI, on the same
// VPS (same SSH/local connection as Valheim — nothing here opens a
// second connection). Fully additive: nothing in this file is called by,
// or changes the behavior of, the Valheim parts. No Mods or Setup tab here
// on purpose — Steam Workshop mods are wired directly into servertest.ini
// per the setup guide, not managed from this GUI, and there's no bootstrap
// wizard equivalent (yet).
// ==========================================================================

const PZ = config.zomboid || null;

// Live server output lives directly in the Zomboid data dir as
// server-console.txt — NOT under Logs/, which only holds timestamped/zipped
// archives from past sessions (confirmed against the Project Zomboid
// Dedicated Server Setup Guide). This is Zomboid's equivalent of Valheim's
// BepInEx LogOutput.log for tailing purposes.
const PZ_LOG_FILE = PZ ? `${PZ.dataDir}/server-console.txt` : null;

function requirePz(req, res) {
  if (!PZ || !PZ.enabled) {
    res.status(404).json({ error: 'Project Zomboid is not configured — add a "zomboid" block to config.json' });
    return false;
  }
  return true;
}

// Shells out to mcrcon (github.com/Tiiffi/mcrcon — not an apt package on
// Ubuntu, built from source per its own INSTALL.md). Returns {ok, output}
// rather than throwing: a wrong password or a down server are routine,
// expected outcomes here, not exceptional ones. The three error strings
// matched below are mcrcon's own literal stdout/stderr text, confirmed
// directly against its source (mcrcon.c) rather than guessed.
async function pzRcon(command) {
  if (!PZ.rcon || !PZ.rcon.password) {
    return { ok: false, output: 'RCON password is not set — add it to zomboid.rcon.password in config.json.' };
  }
  const cmd = `mcrcon -H 127.0.0.1 -P ${PZ.rcon.port || 27015} -p ${shq(PZ.rcon.password)} ${shq(command)} 2>&1`;
  const r = await sshExec(cmd);
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (/command not found|No such file or directory/i.test(out)) {
    return { ok: false, output: "mcrcon isn't installed on the VPS (it's built from source, not an apt package — see github.com/Tiiffi/mcrcon)." };
  }
  if (/Authentication failed/i.test(out)) {
    return { ok: false, output: "RCON authentication failed — zomboid.rcon.password in config.json doesn't match RCONPassword in servertest.ini." };
  }
  if (/Connection failed/i.test(out)) {
    return { ok: false, output: 'Could not reach RCON — is the server running, and does zomboid.rcon.port match RCONPort in servertest.ini?' };
  }
  return { ok: true, output: out };
}

// ---- Status / info / service actions ----

app.get('/api/pz/status', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const svc = PZ.serviceName;
    const port = (PZ.connect && PZ.connect.port) || 16261;
    // Same "is the port actually open" check as Valheim's /api/status,
    // adapted for Zomboid's default UDP port.
    const r = await sshExec(
      `systemctl is-active ${svc} 2>/dev/null; echo ---; ` +
        `systemctl show ${svc} --property=ActiveEnterTimestamp --value 2>/dev/null; echo ---; ` +
        `PORT_HEX=$(printf '%04X' ${port}); ` +
        `cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk -v want="$PORT_HEX" '{ n=split($2,a,":"); if (toupper(a[n]) == want) f=1 } END { exit !f }' && echo LISTENING || echo NOT_LISTENING`
    );
    const [state, since, portStatus] = r.stdout.split('---').map((s) => s.trim());
    res.json({
      state: state || 'unknown',
      since: since || null,
      portOpen: portStatus === 'LISTENING',
      port,
      connectHost: config.publicHost || config.ssh.host || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/server/:action', async (req, res) => {
  if (!requirePz(req, res)) return;
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  try {
    // KillSignal=SIGINT in the unit (per the setup guide) lets systemctl
    // stop/restart flush the world save cleanly — no separate "graceful
    // stop via RCON quit" path needed here.
    const r = await sshExec(maybeSudo(`systemctl ${action} ${PZ.serviceName}`));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- System resource stats (its own CPU sampler, independent of Valheim's) ----

let lastPzCpuSample = null; // { pid, ticks, atMs }

app.get('/api/pz/system/stats', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await sshExec(
      `nproc; echo ---; cat /proc/loadavg; echo ---; free -m; echo ---; df -h / | tail -1; echo ---; ` +
        `PID=$(systemctl show ${PZ.serviceName} -p MainPID --value 2>/dev/null); ` +
        `if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/stat" ]; then ` +
        `echo "PID=$PID"; awk '{print $14, $15}' "/proc/$PID/stat"; else echo NOPID; fi`
    );
    const [coresRaw, loadRaw, freeRaw, diskRaw, procRaw] = r.stdout.split('---').map((s) => s.trim());
    const cores = parseInt(coresRaw, 10) || 1;
    const load = loadRaw.split(' ').slice(0, 3).map(Number);
    const memLine = freeRaw.split('\n').find((l) => l.startsWith('Mem:'));
    const memParts = memLine ? memLine.trim().split(/\s+/) : [];
    const memTotalMB = parseInt(memParts[1], 10) || 0;
    const memUsedMB = parseInt(memParts[2], 10) || 0;
    const diskParts = diskRaw.trim().split(/\s+/);

    // Same delta-based per-process %CPU as Valheim's sampler (see the
    // comment above /api/system/stats in dashboard.js) — 100% = one full core, top/htop
    // convention — but with its own independent sample state so polling
    // one game's stats never disturbs the other's baseline.
    let pzRunning = false;
    let pzPid = null;
    let pzCpuPercent = null;
    const procLines = (procRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (procLines[0] && procLines[0].startsWith('PID=') && procLines[1]) {
      pzRunning = true;
      pzPid = procLines[0].slice(4);
      const [utime, stime] = procLines[1].split(/\s+/).map(Number);
      const ticks = (utime || 0) + (stime || 0);
      const now = Date.now();
      if (lastPzCpuSample && lastPzCpuSample.pid === pzPid) {
        const dTicks = ticks - lastPzCpuSample.ticks;
        const dSecs = (now - lastPzCpuSample.atMs) / 1000;
        if (dSecs > 0.5) pzCpuPercent = Math.max(0, Math.round((dTicks / 100 / dSecs) * 100));
      }
      lastPzCpuSample = { pid: pzPid, ticks, atMs: now };
    } else {
      lastPzCpuSample = null;
    }

    res.json({
      cores,
      loadAvg: load,
      cpuPercent: Math.min(100, Math.round((load[0] / cores) * 100)),
      memTotalMB,
      memUsedMB,
      memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
      diskTotal: diskParts[1],
      diskUsed: diskParts[2],
      diskPercent: parseInt(diskParts[4], 10) || null,
      pzRunning,
      pzPid,
      pzCpuPercent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Players (via RCON — Zomboid has no BepInEx-style log to tail) ----

app.get('/api/pz/players', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await pzRcon('players');
    if (!r.ok) return res.json({ players: [], error: r.output });
    // Project Zomboid's documented `players` response is a header line
    // ("Players connected (N):") followed by one "-Name" line per player.
    // Parsed leniently here since it hasn't been checked against a real
    // server response yet — worth a quick sanity check once this is live.
    const players = r.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generic RCON passthrough — quick-action buttons (save/players/broadcast/
// kick/ban) and the free-form command box on the PZ dashboard both call
// this one endpoint.
app.post('/api/pz/rcon', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { command } = req.body || {};
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'missing command' });
  try {
    const r = await pzRcon(String(command).trim());
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Mods (Steam Workshop) ----
// The running server already fetches/updates whatever WorkshopItems= lists
// at its own startup (per the setup guide) — nothing here duplicates that
// or touches the live process. This only edits two paired lines in
// servertest.ini (WorkshopItems= and Mods=) plus a small sidecar JSON file
// that remembers which Workshop ID contributed which internal Mod ID(s),
// since the ini itself doesn't encode that relationship.

const PZ_INI_PATH = PZ ? `${PZ.dataDir}/Server/${PZ.serverName}.ini` : null;
const PZ_MODS_SIDECAR = PZ ? `${PZ.dataDir}/Server/zomboid-mods.json` : null;
// The base game's app id — Workshop content for Zomboid is registered
// there, not under the dedicated server tool's own app id (380870).
// Confirmed directly against community server-setup guides.
const PZ_WORKSHOP_APPID = 108600;

// Accepts a bare numeric ID or a workshop page URL (both the current
// /sharedfiles/ path and the older /workshop/ path use ?id=).
function pzExtractWorkshopId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

function pzParseIniList(iniText, key) {
  const m = iniText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) return [];
  return m[1].split(';').map((s) => s.trim()).filter(Boolean);
}

async function pzReadIni() {
  const r = await sshExec(`cat ${shq(PZ_INI_PATH)} 2>/dev/null`);
  const mapLine = r.stdout.match(/^Map=(.*)$/m);
  return { text: r.stdout, workshopItems: pzParseIniList(r.stdout, 'WorkshopItems'), mods: pzParseIniList(r.stdout, 'Mods'), map: mapLine ? mapLine[1].trim() : '' };
}

async function pzReadModsSidecar() {
  try {
    const r = await sshExec(`cat ${shq(PZ_MODS_SIDECAR)} 2>/dev/null`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : {};
  } catch (e) {
    return {}; // missing/unreadable/corrupt — start fresh rather than failing the whole request
  }
}

async function pzWriteModsSidecar(data) {
  const b64 = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
  await sshExec(`echo ${shq(b64)} | base64 -d > ${shq(PZ_MODS_SIDECAR)}`);
}

// Rewrites WorkshopItems=/Mods= in place — every other line of the ini is
// left untouched — after backing up the ini first. Base64-encodes both
// replacement lines before interpolating them into the remote command (same
// technique as the Setup tab's systemd-apply): servertest.ini values can
// contain characters that would otherwise need careful shell-escaping, and
// base64's alphabet sidesteps that entirely. The read (awk > tmp) and the
// write (cp tmp back over the original) are kept as separate steps
// deliberately — piping `awk file | tee file` reads and truncates the same
// file at once, which is a real race; `cp` onto an existing file preserves
// its owner/permissions (pzuser), which a plain `>` from a fresh awk output
// would not.
async function pzWriteIniLists(workshopItems, mods, map) {
  const wsLine = `WorkshopItems=${workshopItems.join(';')}`;
  const modsLine = `Mods=${mods.join(';')}`;
  const wsB64 = Buffer.from(wsLine, 'utf8').toString('base64');
  const modsB64 = Buffer.from(modsLine, 'utf8').toString('base64');
  // Map= is only rewritten when a value is given (a mod history restore); every other edit leaves it alone.
  const hasMap = typeof map === 'string' && map.length > 0;
  const mapB64 = Buffer.from(`Map=${hasMap ? map : ''}`, 'utf8').toString('base64');
  const backupPath = `${PZ_INI_PATH}.bak.${Date.now()}`;
  const tmpPath = `${PZ_INI_PATH}.tmp.${Date.now()}`;
  const cmd = [
    `cp ${shq(PZ_INI_PATH)} ${shq(backupPath)}`,
    `WSLINE="$(printf '%s' ${shq(wsB64)} | base64 -d)"`,
    `MODSLINE="$(printf '%s' ${shq(modsB64)} | base64 -d)"`,
    `MAPLINE="$(printf '%s' ${shq(mapB64)} | base64 -d)"`,
    `awk -v ws="$WSLINE" -v mods="$MODSLINE" -v map="$MAPLINE" -v hasMap=${hasMap ? 1 : 0} '` +
      `{ if ($0 ~ /^WorkshopItems=/) { print ws; wsSeen=1 } ` +
      `else if ($0 ~ /^Mods=/) { print mods; modsSeen=1 } ` +
      `else if (hasMap == 1 && $0 ~ /^Map=/) { print map; mapSeen=1 } ` +
      `else print } ` +
      `END { if (!wsSeen) print ws; if (!modsSeen) print mods; if (hasMap == 1 && !mapSeen) print map }` +
      `' ${shq(PZ_INI_PATH)} > ${shq(tmpPath)}`,
    `cp ${shq(tmpPath)} ${shq(PZ_INI_PATH)}`,
    `rm -f ${shq(tmpPath)}`,
    `echo APPLIED`,
  ].join(' && ');
  const r = await sshExec(cmd);
  if (!r.stdout.includes('APPLIED')) throw new Error(`ini write did not complete as expected: ${r.stdout} ${r.stderr}`);
  return backupPath;
}

// ---- Mod history: snapshots and rollback ----
// The Workshop list, Mods= list, Map= line and the sidecar are saved as small JSON files in
// <dataDir>/mod-snapshots (inside the folder the backups already archive) before every change,
// newest 30 kept. Restoring shows a plan first and changes only the lines that are ticked.
const PZ_SNAP_DIR = PZ ? `${PZ.dataDir}/mod-snapshots` : null;
const PZ_SNAP_KEEP = 30;
const PZ_SNAP_ID_RE = /^snap:(\d{8}-\d{6}(?:-\d{1,2})?)$/;

async function pzCaptureModSet() {
  const [ini, sidecar] = await Promise.all([pzReadIni(), pzReadModsSidecar()]);
  return pzmodsets.normalize({ workshopItems: ini.workshopItems, mods: ini.mods, map: ini.map, sidecar });
}

// Newest first: [{ id, file, snap }]. Files that are not valid snapshots are skipped.
async function pzReadSnapshots() {
  const r = await sshExec(`cd ${shq(PZ_SNAP_DIR)} 2>/dev/null && for f in $(ls -1 | grep -E '^[0-9]{8}-[0-9]{6}(-[0-9]{1,2})?\\.json$' | sort -r | head -n ${PZ_SNAP_KEEP}); do printf '%s\\t' "$f"; base64 -w0 < "$f"; echo; done`);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [file, b64] = line.split('\t');
    if (!file || !b64) continue;
    try {
      const snap = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      if (!snap || !Array.isArray(snap.workshopItems)) continue;
      out.push({ id: `snap:${file.replace(/\.json$/, '')}`, file, snap });
    } catch (e) { /* unreadable: skip */ }
  }
  return out;
}

async function pzTakeSnapshot(reason, { force = false } = {}) {
  const cur = await pzCaptureModSet();
  if (!force) {
    const latest = (await pzReadSnapshots())[0];
    if (latest) {
      const age = Date.now() - Date.parse(latest.snap.ts || 0);
      if (pzmodsets.sameSet(latest.snap, cur) || age < 90 * 1000) return { saved: false, count: cur.workshopItems.length };
    }
  }
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  let name = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  const body = { id: name, ts: d.toISOString(), reason: String(reason || 'Snapshot').slice(0, 120), ...cur };
  const b64 = Buffer.from(JSON.stringify(body, null, 1), 'utf8').toString('base64');
  // A second snapshot in the same second gets a -1, -2 ... suffix instead of overwriting.
  const r = await sshExec(
    `mkdir -p ${shq(PZ_SNAP_DIR)} && cd ${shq(PZ_SNAP_DIR)} && N=${shq(name)} && i=0 && while [ -e "$N.json" ]; do i=$((i+1)); N=${shq(name)}-$i; done && ` +
      `printf '%s' ${shq(b64)} | base64 -d > "$N.json" && echo "SAVED $N" && ` +
      `(ls -1 | grep -E '^[0-9]{8}-[0-9]{6}(-[0-9]{1,2})?\\.json$' | sort -r | tail -n +${PZ_SNAP_KEEP + 1} | xargs -r rm -f)`
  );
  const m = /SAVED (\S+)/.exec(r.stdout);
  if (!m) throw new Error(`could not save the snapshot: ${r.stderr || r.stdout}`.trim());
  return { saved: true, id: `snap:${m[1]}`, count: cur.workshopItems.length };
}

// Before a change: best-effort, a failed snapshot never blocks the change itself.
async function pzSnapshotBefore(reason) {
  try { await pzTakeSnapshot(reason); } catch (e) { console.error('[pz mod snapshot] skipped:', e.message); }
}

async function pzLoadSnapshot(id) {
  const m = PZ_SNAP_ID_RE.exec(String(id || ''));
  if (!m) return null;
  const r = await sshExec(`cat ${shq(`${PZ_SNAP_DIR}/${m[1]}.json`)} 2>/dev/null`);
  try {
    const snap = JSON.parse(r.stdout);
    return snap && Array.isArray(snap.workshopItems) ? snap : null;
  } catch (e) {
    return null;
  }
}

app.get('/api/pz/mods/history', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const items = (await pzReadSnapshots()).map((x) => ({
      id: x.id,
      kind: 'snapshot',
      ts: x.snap.ts || null,
      reason: x.snap.reason || 'Snapshot',
      count: pzmodsets.describe(x.snap).count,
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/snapshot', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await pzTakeSnapshot(String((req.body || {}).reason || 'Saved manually'), { force: true });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pz/mods/restore-plan', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const snap = await pzLoadSnapshot(req.query.id);
    if (!snap) return res.status(404).json({ error: 'That snapshot could not be found or read.' });
    const plan = pzmodsets.planRestore(await pzCaptureModSet(), snap);
    res.json({ id: req.query.id, label: snap.reason || 'Snapshot', ts: snap.ts || null, ...plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Applies the ticked lines of a plan. The plan is rebuilt here from the saved snapshot, so the
// browser only says which lines (by key); it never supplies mod data.
app.post('/api/pz/mods/restore', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { id, keys } = req.body || {};
  if (!Array.isArray(keys) || !keys.length || !keys.every((k) => typeof k === 'string' && k.length < 200)) {
    return res.status(400).json({ error: 'Tick at least one change to restore.' });
  }
  try {
    const snap = await pzLoadSnapshot(id);
    if (!snap) return res.status(404).json({ error: 'That snapshot could not be found or read.' });
    const current = await pzCaptureModSet();
    let next;
    try {
      next = pzmodsets.applyPlan(current, snap, keys);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    // The current state is saved first (always), so a restore can itself be undone.
    await pzTakeSnapshot('Before a restore', { force: true });
    const backupPath = await pzWriteIniLists(next.workshopItems, next.mods, next.map);
    await pzWriteModsSidecar(next.sidecar);
    res.json({ ok: true, applied: keys.length, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pz/mods/list', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const [sidecar, ini] = await Promise.all([pzReadModsSidecar(), pzReadIni()]);
    const managedModIds = new Set();
    const entries = ini.workshopItems.map((id) => {
      const rec = sidecar[id] || {};
      (rec.modIds || []).forEach((m) => managedModIds.add(m));
      return {
        workshopId: id,
        name: rec.name || `Workshop ${id}`,
        modIds: rec.modIds || [],
        addedAt: rec.addedAt || null,
        unrecorded: !sidecar[id],
      };
    });
    const unmanagedModIds = ini.mods.filter((id) => !managedModIds.has(id));
    res.json({ entries, unmanagedModIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pre-fetches a Workshop item with SteamCMD (into the server's own install
// dir — the exact cache location it uses itself at startup, so nothing here
// is wasted) and scans the result for mod.info, which is the only reliable
// source for a mod's internal ID(s) — a single Workshop item occasionally
// bundles more than one. Read-only: does not touch the ini. Same
// steamcmd/app-id combination as the setup guide's own manual instructions.
app.post('/api/pz/mods/detect', async (req, res) => {
  if (!requirePz(req, res)) return;
  const workshopId = pzExtractWorkshopId((req.body || {}).input);
  if (!workshopId) {
    return res.status(400).json({ error: "Couldn't find a Workshop ID in that — paste the numeric ID or the workshop page URL." });
  }
  try {
    const contentDir = `${PZ.installDir}/steamapps/workshop/content/${PZ_WORKSHOP_APPID}/${workshopId}`;
    const cmd =
      `steamcmd +force_install_dir ${shq(PZ.installDir)} +login anonymous +workshop_download_item ${PZ_WORKSHOP_APPID} ${workshopId} +quit 2>&1; ` +
      `echo ---; ` +
      `find ${shq(contentDir)} -name mod.info 2>/dev/null -exec sh -c ` +
      `'id=$(grep -m1 "^id=" "$1" | cut -d= -f2-); name=$(grep -m1 "^name=" "$1" | cut -d= -f2-); printf "%s\\t%s\\n" "$id" "$name"' _ {} \\;`;
    const r = await sshExec(cmd);
    const [dlOutput, foundRaw] = r.stdout.split('---');
    const mods = (foundRaw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, name] = l.split('\t');
        return { id: (id || '').trim(), name: (name || '').trim() };
      })
      .filter((m) => m.id);
    if (!mods.length) {
      const tail = (dlOutput || '').trim().split('\n').slice(-6).join('\n');
      return res.json({ workshopId, mods: [], error: tail ? `Last steamcmd output:\n${tail}` : undefined });
    }
    res.json({ workshopId, mods });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/add', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { workshopId, mods, name } = req.body || {}; // mods: [{id, name}]
  if (!workshopId || !Array.isArray(mods) || !mods.length) {
    return res.status(400).json({ error: 'missing workshopId or mods' });
  }
  try {
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    if (workshopItems.includes(String(workshopId))) {
      return res.status(400).json({ error: 'That Workshop item is already added.' });
    }
    const newModIds = mods.map((m) => String(m.id || '').trim()).filter(Boolean);
    if (!newModIds.length) return res.status(400).json({ error: 'No Mod IDs given.' });
    await pzSnapshotBefore(`Before adding ${(name || '').trim() || mods.map((m) => m.name).filter(Boolean).join(', ') || `Workshop ${workshopId}`}`);
    const mergedWs = [...workshopItems, String(workshopId)];
    const mergedMods = [...currentModIds, ...newModIds.filter((id) => !currentModIds.includes(id))];
    const backupPath = await pzWriteIniLists(mergedWs, mergedMods);
    const sidecar = await pzReadModsSidecar();
    sidecar[workshopId] = {
      modIds: newModIds,
      name: (name || '').trim() || mods.map((m) => m.name).filter(Boolean).join(', ') || `Workshop ${workshopId}`,
      addedAt: new Date().toISOString(),
    };
    await pzWriteModsSidecar(sidecar);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/remove', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { workshopId } = req.body || {};
  if (!workshopId) return res.status(400).json({ error: 'missing workshopId' });
  try {
    const sidecar = await pzReadModsSidecar();
    const entry = sidecar[workshopId];
    await pzSnapshotBefore(`Before removing ${(entry && entry.name) || `Workshop ${workshopId}`}`);
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    const remainingWs = workshopItems.filter((id) => id !== String(workshopId));
    // Only drop mod ids this entry owned, and only if no other remaining
    // sidecar entry still claims the same id (two Workshop items can rarely
    // share an internal Mod ID — a shared framework dependency, say).
    const stillClaimed = new Set();
    Object.entries(sidecar).forEach(([id, rec]) => {
      if (id !== String(workshopId)) (rec.modIds || []).forEach((m) => stillClaimed.add(m));
    });
    const toDrop = new Set((entry && entry.modIds) || []);
    const remainingMods = currentModIds.filter((id) => !toDrop.has(id) || stillClaimed.has(id));
    const backupPath = await pzWriteIniLists(remainingWs, remainingMods);
    delete sidecar[workshopId];
    await pzWriteModsSidecar(sidecar);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pz/mods/reorder', async (req, res) => {
  if (!requirePz(req, res)) return;
  const { order } = req.body || {}; // array of workshopId strings, new order
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'missing order' });
  try {
    await pzSnapshotBefore('Before reordering');
    const sidecar = await pzReadModsSidecar();
    const { workshopItems, mods: currentModIds } = await pzReadIni();
    // Anything the client didn't send (shouldn't normally happen) is kept,
    // appended at the end, rather than silently dropped.
    const known = new Set(order.map(String));
    const finalWs = [...order.map(String), ...workshopItems.filter((id) => !known.has(id))];
    const managedModIds = new Set();
    Object.values(sidecar).forEach((rec) => (rec.modIds || []).forEach((m) => managedModIds.add(m)));
    const orderedModIds = [];
    finalWs.forEach((id) => {
      const rec = sidecar[id];
      if (rec) (rec.modIds || []).forEach((m) => { if (!orderedModIds.includes(m)) orderedModIds.push(m); });
    });
    // Unmanaged mod ids (in Mods= from before this feature existed, or
    // added by hand) keep their place at the end, untouched by reordering.
    currentModIds.forEach((id) => {
      if (!managedModIds.has(id) && !orderedModIds.includes(id)) orderedModIds.push(id);
    });
    const backupPath = await pzWriteIniLists(finalWs, orderedModIds);
    res.json({ ok: true, backupPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Backups ----
// No dedicated backup script exists for PZ (unlike Valheim's
// backup-valheim.sh) — the setup guide's own approach is a plain tar of the
// whole ~/Zomboid folder (Saves + Server config together), so that's what
// this runs directly instead of requiring a script to be deployed first.

app.get('/api/pz/backup/run', (req, res) => {
  if (!requirePz(req, res)) return;
  const parentDir = path.dirname(PZ.dataDir);
  const baseName = path.basename(PZ.dataDir);
  const stamp = 'zomboid-$(date +%Y%m%d-%H%M%S).tar.gz';
  const cmd = [
    `mkdir -p ${shq(PZ.backupDir)}`,
    `cd ${shq(parentDir)}`,
    `tar -czf ${shq(PZ.backupDir)}/${stamp} ${shq(baseName)}`,
    `echo "BACKED UP"`,
  ].join(' && ');
  sshExecStream(cmd, res);
});

app.get('/api/pz/backup/list', async (req, res) => {
  if (!requirePz(req, res)) return;
  try {
    const r = await sshExec(`ls -1t ${shq(PZ.backupDir)} 2>/dev/null | grep -v -e '\\.txt$' | head -50`);
    res.json({ files: r.stdout.split('\n').filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore: stop the service, extract the chosen backup tarball back over
// ~/Zomboid (Saves + Server together, matching how backup/run created it),
// restart. Same integrity-check-before-touching-anything approach as
// Valheim's /api/backup/restore.
app.post('/api/pz/backup/restore', (req, res) => {
  if (!requirePz(req, res)) return;
  const { file } = req.body;
  if (!file) return res.status(400).json({ error: 'missing file' });
  const svc = PZ.serviceName;
  const backupPath = `${PZ.backupDir}/${file}`;
  const parentDir = path.dirname(PZ.dataDir);
  const cmd = [
    `echo "Verifying backup integrity before touching anything..."`,
    `tar -tzf ${shq(backupPath)} > /dev/null`,
    `echo "Backup verified OK."`,
    maybeSudo(`systemctl stop ${svc}`),
    `echo "Stopped ${svc}, extracting ${file}..."`,
    `tar -xzf ${shq(backupPath)} -C ${shq(parentDir)}`,
    `echo "Extracted. Starting ${svc}..."`,
    maybeSudo(`systemctl start ${svc}`),
    `echo "RESTORED ${file}"`,
  ].join(' && ');
  sshExecPlainStream(cmd, res);
});

// ---- Updates ----
// No separate "check" script exists for PZ either — the guide's own update
// flow is just re-running the SteamCMD install command, which is a no-op if
// already current and prints what it changed either way. That doubles as
// both check and apply, streamed live so a mod-compatibility warning (see
// the guide's closing note) is visible as it happens.

// The update runs as one script (vps-scripts/update-zomboid.sh), filled in here and run as root
// over SSH, so nothing has to be deployed to the VPS first. See the script's header for the steps.
function pzUpdateScript(force) {
  const vals = {
    PZ_SERVICE: PZ.serviceName,
    PZ_INSTALL_DIR: PZ.installDir,
    PZ_DATA_DIR: PZ.dataDir,
    PZ_BACKUP_DIR: PZ.backupDir,
    PZ_FORCE: force ? '1' : '0',
  };
  for (const [k, v] of Object.entries(vals)) {
    if (!v || !setup.SAFE_SETUP_VALUE.test(v)) throw new Error(`The config value for zomboid ${k} ("${v}") is empty or has characters the update script does not allow (use letters, digits and . _ / - only).`);
  }
  const text = fs.readFileSync(path.join(ROOT, 'vps-scripts', 'update-zomboid.sh'), 'utf8').replace(/__([A-Z][A-Z_]*)__/g, (m, k) => (k in vals ? vals[k] : m));
  const left = text.match(/__[A-Z][A-Z_]*__/);
  if (left) throw new Error(`update-zomboid.sh: value ${left[0]} was not filled in`);
  return text;
}

// What the script's last "RESULT:" line means for Discord. Up to date and a refused start say nothing.
function pzUpdateDiscordMessage(lines) {
  const line = [...lines].reverse().find((l) => /^RESULT: /.test(l));
  if (!line) return null;
  const [, outcome, from, to] = line.match(/^RESULT: (\S+)(?: (\S+))?(?: (\S+))?/) || [];
  switch (outcome) {
    case 'updated': return `✅ **Project Zomboid server updated** (build ${from} → ${to}). A backup was taken beforehand and the server was started again. Check your Workshop mods.`;
    case 'updated-not-started': return '⚠️ **Project Zomboid was updated but the server did not start.** The backup is safe. Check `systemctl status` on the VPS.';
    case 'failed-restarted': return '❌ **Project Zomboid update failed.** A backup was taken and the server was **started again on the build it already had**. See the update output in the GUI.';
    case 'failed-down': return '❌ **Project Zomboid update failed and the server did not start.** The backup is safe. Check the update output in the GUI and `systemctl status` on the VPS.';
    default: return null;
  }
}

app.get('/api/pz/update/apply', (req, res) => {
  if (!requirePz(req, res)) return;
  let script;
  try {
    script = pzUpdateScript(req.query.force === '1');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  sshExecStream(setup.asRootScript(script), res, {
    idleMs: 1800000,
    onDone: (code, lines) => {
      const msg = pzUpdateDiscordMessage(lines);
      if (msg) notifyDiscord(msg);
    },
  });
});

// ---- Logs ----
// Same shape as Valheim's /api/logs/* — journal, plus a direct file tail,
// plus a live follow of either. PZ_LOG_FILE (server-console.txt) stands in
// for Valheim's config.paths.logFile.

app.get('/api/pz/logs/tail', async (req, res) => {
  if (!requirePz(req, res)) return;
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(PZ_LOG_FILE)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pz/logs/journal', async (req, res) => {
  if (!requirePz(req, res)) return;
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`journalctl -u ${PZ.serviceName} -n ${lines} --no-pager`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live-follow either the journal or server-console.txt itself.
app.get('/api/pz/logs/live', (req, res) => {
  if (!requirePz(req, res)) return;
  const source = req.query.source === 'tail' ? 'tail' : 'journal';
  const cmd =
    source === 'tail'
      ? `tail -n 20 -F ${shq(PZ_LOG_FILE)}`
      : `journalctl -u ${PZ.serviceName} -n 20 -f --no-pager`;
  sshExecFollow(cmd, req, res);
});
