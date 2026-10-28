// Start/stop and status of the Valheim server.

const { config } = require('./context');
const { shq, sshExec, maybeSudo, asLgsmUser } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const worldInfo = require('./world-info');

// ---- Server control ----

// Shell snippet, not a standalone command: resolves the running Valheim
// process's PID via pgrep (there's no systemd unit to ask anymore — LGSM
// just forks the process directly) and, if found, its start time formatted
// the same way systemd used to ("YYYY-MM-DD HH:MM:SS UTC") so the frontend's
// existing parseSystemdTime() keeps working unchanged. Echoes "active"/
// "inactive" to match the state strings the frontend already understands
// (there's no LGSM equivalent of systemd's transient "activating"/"failed"
// states, so those are simply not distinguishable here — an honest
// degradation, not a guess).
function stateSnippet() {
  return [
    `PID=$(pgrep -u ${shq(config.lgsmUser || 'vhserver')} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
    `if [ -n "$PID" ]; then echo active; ` +
      `START_EPOCH=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
      `if [ -n "$START_EPOCH" ]; then date -u -d "@$START_EPOCH" '+%Y-%m-%d %H:%M:%S UTC'; fi; ` +
      `else echo inactive; fi`,
  ].join('; ');
}

app.get('/api/status', async (req, res) => {
  try {
    const port = (await worldInfo.getWorldInfo()).port || 2456;
    const queryPort = port + 1;
    // Process liveness alone says nothing about whether Valheim has
    // actually finished loading the world and is listening for players.
    // Check the real UDP ports too, via /proc/net/udp directly (works on
    // any Linux system, no dependency on a specific tool's CLI syntax like
    // `ss`'s filter DSL). Checks BOTH the game port and the query port
    // (game port + 1) and treats either one as "open": confirmed directly
    // against a live server that with `-crossplay` on (this project's
    // actual setup), the game port never shows as a bound listening
    // socket at all — Valheim routes crossplay traffic through PlayFab's
    // relay/P2P layer instead of a plain UDP listen — while the query
    // port (used for the classic Steam server-browser query) does bind
    // normally. LGSM's own `ss`-based check in `./vhserver details` shows
    // the identical split (Game: 0, Query: 1), so this isn't a quirk of
    // this /proc/net/udp method — it's inherent to how crossplay works.
    // Without this OR, the Dashboard would show "not listening" forever
    // on a crossplay server that is, in every other respect, up and
    // actively registered with a live join code.
    const cmd = [
      stateSnippet(),
      `echo ---`,
      `GAME_HEX=$(printf '%04X' ${port}); QUERY_HEX=$(printf '%04X' ${queryPort})`,
      `cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk -v g="$GAME_HEX" -v q="$QUERY_HEX" ` +
        `'{ n=split($2,a,":"); p=toupper(a[n]); if (p==g) fg=1; if (p==q) fq=1 } END { print (fg?"1":"0") (fq?"1":"0") }'`,
    ].join('; ');
    const r = await sshExec(cmd);
    const [stateBlock, portFlags] = r.stdout.split('---').map((s) => s.trim());
    const [state, ts] = stateBlock.split('\n').map((s) => s.trim());
    const gameOpen = portFlags[0] === '1';
    const queryOpen = portFlags[1] === '1';
    res.json({
      state: state || 'unknown',
      since: ts || null,
      portOpen: gameOpen || queryOpen,
      port,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/server/:action', async (req, res) => {
  const action = req.params.action;
  // 'restart' is intentionally not offered for the Valheim server: stop and
  // start are run as two separate, explicit steps so the world is saved on
  // the stop before anything starts again.
  if (!['start', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'invalid action — use stop, then start' });
  }
  try {
    const script = config.paths.lgsmScript || `/home/${config.lgsmUser || 'vhserver'}/vhserver`;
    if (action === 'start') {
      // Several worlds share one VPS: refuse a start that would collide with another world's port.
      const me = await worldInfo.getWorldInfo();
      if (!config.instance.main && !me.portExplicit) {
        return res.status(409).json({ error: 'This world has no game port saved yet. Open Setup, step 3, and save one (each world needs its own).' });
      }
      const clash = (await worldsPage.otherWorldPorts()).find((o) => worldsPage.portsOverlap(o.port, me.port));
      if (clash) return res.status(409).json({ error: `Game port ${me.port} overlaps the world "${clash.label}" (port ${clash.port}). A Valheim server also uses the next two ports, so keep worlds at least 3 apart. Change it in Settings.` });
    }
    // LinuxGSM colors its output; drop the escape codes (and its in-place "\r" redraws) so the console is readable.
    const clean = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n');
    const stopFlag = `${config.lgsmHome}/.stopped-by-gui`;
    // A server stopped from here is a deliberate stop: the health check must not report it as a crash.
    if (action === 'start') await sshExec(maybeSudo(`rm -f ${shq(stopFlag)}`));
    let r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
    if (action === 'stop' && r.code === 0) await sshExec(maybeSudo(`touch ${shq(stopFlag)}`));
    let note = '';
    // LinuxGSM refuses to start when any file under its lgsm/ or serverfiles/ folder is not owned by
    // the game account (a backup or side file written as root is enough). Fixing that is what the
    // install steps already do after every change, so do it here once and retry.
    if (action === 'start' && r.code !== 0 && /Ownership issues found/.test(r.stdout || '')) {
      const user = config.lgsmUser;
      const fix = await sshExec(maybeSudo(`chown -R ${shq(`${user}:${user}`)} ${shq(`${config.lgsmHome}/lgsm`)} ${shq(config.paths.valheimServerDir)}`) + ' && echo FIXED');
      if (fix.stdout.includes('FIXED')) {
        note = '[note] Some files under the LinuxGSM folders were owned by root, which makes LinuxGSM refuse to start. Their owner was corrected and the start was retried.\n';
        r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
      }
    }
    // On a brand-new install LinuxGSM fetches its start module from GitHub the first time. A dropped
    // connection there fails the start for no real reason, so try again a couple of times.
    for (let i = 0; i < 2 && action === 'start' && r.code !== 0 && /Downloading .*FAIL|FAIL.*Downloading/s.test(clean(r.stdout) + clean(r.stderr)); i++) {
      await new Promise((ok) => setTimeout(ok, 4000));
      note = '[note] LinuxGSM could not download one of its own files (network hiccup); retrying the start.\n';
      r = await sshExec(asLgsmUser(`${shq(script)} ${action}`));
    }
    res.json({ ...r, stdout: note + clean(r.stdout), stderr: clean(r.stderr) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { stateSnippet });
