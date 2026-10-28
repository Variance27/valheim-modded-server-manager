// Opening game ports with ufw.

const { curId, readRegistry } = require('./context');
const { shq, sshExec } = require('./exec');
const { app } = require('./app');
const worldInfo = require('./world-info');
const setup = require('./setup');

// ---- Firewall (ufw) ----
//
// A Valheim world needs UDP <port> to <port>+2 open. When the VPS runs ufw AND it is active, the GUI
// opens that range when the port is saved (Setup step 3 / Settings) and before the first start, and
// closes it again when the world is uninstalled. It never turns ufw on or off, never touches any
// other rule, and cannot change a firewall in your hosting provider's panel. Rules carry the comment
// "valheim-gui:<world id>" so they can be recognised later.
const gameRange = (port) => `${Number(port)}:${Number(port) + 2}`;
async function worldGamePort() {
  const info = await worldInfo.getWorldInfo();
  if (curId() === 'main' || info.portExplicit) return Number(info.port);
  const reg = readRegistry().find((i) => i.id === curId());
  return reg && reg.plannedPort ? Number(reg.plannedPort) : null;
}
// mode: status | open | close (any rule on exactly this range) | close-tagged (only a rule this GUI tagged for this world)
async function fwRun(mode, port, tag = `valheim-gui:${curId()}`) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65530) throw new Error(`Refusing to change firewall rules for port ${port}`);
  const range = gameRange(port);
  const script = [
    'set -u',
    `RANGE=${shq(range)}/udp; TAG=${shq(tag)}; MODE=${shq(mode)}`,
    'command -v ufw >/dev/null 2>&1 || { echo "FW:none"; exit 0; }',
    'ufw status 2>/dev/null | head -n1 | grep -qi "inactive" && { echo "FW:inactive"; exit 0; }',
    'echo "FW:active"',
    'has() { ufw status 2>/dev/null | awk -v r="$RANGE" -v t="$1" \'$1==r && (t=="" || index($0,t)>0){f=1} END{exit f?0:1}\'; }',
    'if has ""; then echo "OPEN:yes"; else echo "OPEN:no"; fi',
    'case "$MODE" in',
    '  open) if has ""; then echo "RESULT:already"; else OUT="$(ufw allow "$RANGE" comment "$TAG" 2>&1)" && echo "RESULT:opened" || echo "RESULT:failed $OUT"; fi ;;',
    '  close|close-tagged)',
    '    if [ "$MODE" = close-tagged ]; then T="$TAG"; else T=""; fi',
    '    if has "$T"; then OUT="$(ufw --force delete allow "$RANGE" 2>&1)"; if has ""; then echo "RESULT:failed $OUT"; else echo "RESULT:closed"; fi; else echo "RESULT:absent"; fi ;;',
    'esac',
  ].join('\n');
  const r = await sshExec(setup.asRootScript(script));
  const out = `${r.stdout || ''}`;
  const tool = (/FW:(\w+)/.exec(out) || [])[1] || 'none';
  const result = (/RESULT:(\w+)(?: (.*))?/.exec(out) || []);
  const info = { tool: tool === 'none' ? 'none' : 'ufw', active: tool === 'active', open: /OPEN:yes/.test(out) || result[1] === 'opened', range, result: result[1] || null, detail: result[2] || '' };
  if (result[1] === 'closed') info.open = false;
  info.message = fwMessage(info, mode);
  return info;
}
function fwMessage(f, mode) {
  const udp = `UDP ${f.range}`;
  if (f.tool === 'none') return 'This VPS has no ufw firewall, so there was nothing to change. A firewall in your provider panel is separate and must be set there.';
  if (!f.active) return `The VPS firewall (ufw) is off, so nothing on the VPS blocks ${udp}. A firewall in your provider panel is separate and must be set there.`;
  if (f.result === 'opened') return `Opened ${udp} in the VPS firewall (ufw).`;
  if (f.result === 'already') return `${udp} is already open in the VPS firewall (ufw).`;
  if (f.result === 'closed') return `Closed ${udp} in the VPS firewall (ufw).`;
  if (f.result === 'absent') return `No ufw rule for ${udp} was found, so nothing was closed.`;
  if (f.result === 'failed') return `Could not change the ufw rule for ${udp}: ${f.detail}`;
  return f.open ? `${udp} is open in the VPS firewall (ufw).` : `${udp} is not open in the VPS firewall (ufw).`;
}

app.get('/api/firewall', async (req, res) => {
  try {
    const port = await worldGamePort();
    if (!port) return res.json({ tool: 'none', active: false, open: false, message: 'This world has no game port yet.' });
    res.json({ port, ...(await fwRun('status', port)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/firewall/open', async (req, res) => {
  try {
    const port = await worldGamePort();
    if (!port) return res.status(400).json({ error: 'This world has no game port yet. Save one in Setup step 3 first.' });
    res.json({ port, ...(await fwRun('open', port)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { worldGamePort, gameRange, fwRun });
