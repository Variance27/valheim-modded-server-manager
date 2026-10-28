// Dashboard: server info card and system resource stats.

const { config, curId } = require('./context');
const { sshExec, shq } = require('./exec');
const { app } = require('./app');
const serverControl = require('./server-control');
const worldInfo = require('./world-info');

// ---- Server info (dashboard summary card) ----

app.get('/api/info', async (req, res) => {
  try {
    const r = await sshExec(
      `${serverControl.stateSnippet()}; echo ---; ` +
        `ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null | wc -l`
    );
    const [stateBlock, modCountRaw] = r.stdout.split('---').map((s) => s.trim());
    const [state, since] = stateBlock.split('\n').map((s) => s.trim());
    const world = await worldInfo.getWorldInfo();
    res.json({
      state: state || 'unknown',
      since: since || null,
      modCount: parseInt(modCountRaw, 10) || 0,
      worldName: world.world,
      worldReady: world.ready,
      serverName: world.serverName,
      brand: world.brand,
      instance: config.instance,
      connectHost: config.publicHost || config.ssh.host || '',
      connectPort: world.port || 2456,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- System resource stats ----

// Tracks the previous CPU-ticks sample for the Valheim process so each poll
// can report a delta-based %CPU for just that process — same convention
// `top`/`htop` use (100% = one full core saturated by that process's threads
// combined, not a share of the whole VPS). No explicit sleep is needed: the
// delta is computed against whenever this endpoint was last polled.
const valheimCpuSamples = new Map(); // world id -> { pid, ticks, atMs }
let lastHostCpuStat = null; // { total, steal, iowait } from /proc/stat
// Size of the backup folder, refreshed in the background at most every 5 minutes
// (du can be slow on a big folder, so the stats poll never waits for it).
const backupSizeCaches = new Map();
function backupSizeCache_() {
  const id = curId();
  if (!backupSizeCaches.has(id)) backupSizeCaches.set(id, { t: 0, mb: null, busy: false });
  return backupSizeCaches.get(id);
}
function refreshBackupSize() {
  const dir = config.paths && config.paths.backupDir;
  const backupSizeCache = backupSizeCache_();
  if (!dir || backupSizeCache.busy || Date.now() - backupSizeCache.t < 5 * 60 * 1000) return;
  backupSizeCache.busy = true;
  sshExec(`du -sm ${shq(dir)} 2>/dev/null | cut -f1`)
    .then((r) => { const n = parseInt(r.stdout, 10); if (Number.isFinite(n)) backupSizeCache.mb = n; })
    .catch(() => {})
    .finally(() => { backupSizeCache.t = Date.now(); backupSizeCache.busy = false; });
}

app.get('/api/system/stats', async (req, res) => {
  try {
    const r = await sshExec(
      `nproc; echo ---; cat /proc/loadavg; echo ---; free -m; echo ---; df -h / | tail -1; echo ---; ` +
        `PID=$(pgrep -u ${shq(config.lgsmUser || 'vhserver')} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null); ` +
        `if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then ` +
        `echo "PID=$PID"; awk '{print $14, $15}' "/proc/$PID/stat"; else echo NOPID; fi; echo ---; ` +
        `head -1 /proc/stat; echo ---; ` +
        `if [ -n "$PID" ]; then awk '/VmRSS/{print $2}' "/proc/$PID/status" 2>/dev/null; fi`
    );
    const [coresRaw, loadRaw, freeRaw, diskRaw, procRaw, cpuStatRaw, rssRaw] = r.stdout.split('---').map((s) => s.trim());
    const cores = parseInt(coresRaw, 10) || 1;
    const load = loadRaw.split(' ').slice(0, 3).map(Number);
    const memLine = freeRaw.split('\n').find((l) => l.startsWith('Mem:'));
    const memParts = memLine ? memLine.trim().split(/\s+/) : [];
    const memTotalMB = parseInt(memParts[1], 10) || 0;
    const memUsedMB = parseInt(memParts[2], 10) || 0;
    const diskParts = diskRaw.trim().split(/\s+/);

    // Valheim process CPU (see the valheimCpuSamples comment above).
    let valheimRunning = false;
    let valheimPid = null;
    let valheimCpuPercent = null;
    const procLines = (procRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (procLines[0] && procLines[0].startsWith('PID=') && procLines[1]) {
      valheimRunning = true;
      valheimPid = procLines[0].slice(4);
      const [utime, stime] = procLines[1].split(/\s+/).map(Number);
      const ticks = (utime || 0) + (stime || 0);
      const now = Date.now();
      const lastValheimCpuSample = valheimCpuSamples.get(curId());
      if (lastValheimCpuSample && lastValheimCpuSample.pid === valheimPid) {
        const dTicks = ticks - lastValheimCpuSample.ticks;
        const dSecs = (now - lastValheimCpuSample.atMs) / 1000;
        // USER_HZ is 100 on virtually every Linux distro (glibc default) —
        // getconf CLK_TCK would be the fully portable way to confirm this,
        // but 100 is safe for the Ubuntu VPS this runs on.
        if (dSecs > 0.5) valheimCpuPercent = Math.max(0, Math.round((dTicks / 100 / dSecs) * 100));
      }
      valheimCpuSamples.set(curId(), { pid: valheimPid, ticks, atMs: now });
    } else {
      valheimCpuSamples.delete(curId());
    }

    // Host CPU breakdown since the previous poll: "steal" is time the hypervisor gave to
    // other VPS tenants (a direct cause of lag you can't fix inside the VM); "iowait" is
    // time spent waiting on disk.
    let cpuStealPercent = null;
    let cpuIowaitPercent = null;
    const cs = (cpuStatRaw || '').split(/\s+/).slice(1).map(Number);
    if (cs.length >= 8 && cs.every((n) => Number.isFinite(n))) {
      const total = cs.slice(0, 8).reduce((a, b) => a + b, 0);
      if (lastHostCpuStat && total > lastHostCpuStat.total) {
        const dT = total - lastHostCpuStat.total;
        cpuStealPercent = Math.round(((cs[7] - lastHostCpuStat.steal) / dT) * 1000) / 10;
        cpuIowaitPercent = Math.round(((cs[4] - lastHostCpuStat.iowait) / dT) * 1000) / 10;
      }
      lastHostCpuStat = { total, steal: cs[7], iowait: cs[4] };
    }
    const swapLine = freeRaw.split('\n').find((l) => l.startsWith('Swap:'));
    const swapParts = swapLine ? swapLine.trim().split(/\s+/) : [];
    refreshBackupSize();

    res.json({
      cpuStealPercent,
      cpuIowaitPercent,
      swapTotalMB: parseInt(swapParts[1], 10) || 0,
      swapUsedMB: parseInt(swapParts[2], 10) || 0,
      valheimMemMB: rssRaw && /^\d+$/.test(rssRaw) ? Math.round(parseInt(rssRaw, 10) / 1024) : null,
      backupDirMB: backupSizeCache_().mb,
      cores,
      loadAvg: load,
      cpuPercent: Math.min(100, Math.round((load[0] / cores) * 100)),
      memTotalMB,
      memUsedMB,
      memPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
      diskTotal: diskParts[1],
      diskUsed: diskParts[2],
      diskPercent: parseInt(diskParts[4], 10) || null,
      valheimRunning,
      valheimPid,
      // null on the very first poll (or right after a restart) — needs two
      // samples to compute a delta. The frontend shows "warming up…" for that.
      valheimCpuPercent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
