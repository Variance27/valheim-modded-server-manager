// The Discord /codes bot (a systemd service on the VPS).

const fs = require('fs');
const path = require('path');
const { config, ROOT } = require('./context');
const { shq, sshExec, maybeSudo, sshExecStream } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const worldInfo = require('./world-info');
const schedules = require('./schedules');
const setup = require('./setup');

// ---- Discord /codes bot (API: /api/bot) ----
//
// An optional systemd service on the VPS that answers /codes in Discord by running generate-codes.py.
// Everything lives under BOT_DIR (script, its own Python virtualenv, the worlds list); the token sits
// in a root-only env file. The unit carries BOT_MARK so the GUI never overwrites or removes a bot
// service somebody set up by hand under the same name.
const BOT_DIR = '/opt/valheim-gui-bot';
const BOT_ENV = '/etc/valheim-gui-bot.env';
const BOT_SVC = 'valheim-codes-bot';
const BOT_UNIT = `/etc/systemd/system/${BOT_SVC}.service`;
const BOT_MARK = '# Managed by valheim-gui';
const DISCORD_ID_RE = /^\d{15,25}$/;
const BOT_TOKEN_RE = /^[A-Za-z0-9._-]{40,120}$/;

function sseText(res, lines, code) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const l of lines) res.write(`data: ${l}\n\n`);
  res.write(`event: done\ndata: ${code}\n\n`);
  res.end();
}

// What each world offers the bot: the Mods.yaml and plugins folder to read, and the name Gale shows.
async function botWorldList() {
  const out = [];
  for (const id of worldsPage.worldList()) {
    try {
      out.push(await worldsPage.inWorld(id, async () => {
        const info = await worldInfo.getWorldInfo();
        const label = config.instance.main ? (info.ready ? info.brand : config.instance.label) : config.instance.label;
        return { id, label, profileName: info.brand || 'Valheim', modsYaml: config.paths.enforcerYaml, pluginsDir: config.paths.pluginsDir || '' };
      }));
    } catch (e) {
      /* a world whose paths cannot be worked out is simply not offered */
    }
  }
  return out.filter((w) => w.modsYaml);
}

async function botStatus() {
  const script = [
    `[ -f ${shq(`${BOT_DIR}/discord-codes-bot.py`)} ] && echo "INSTALLED:yes" || echo "INSTALLED:no"`,
    `if [ -f ${shq(BOT_UNIT)} ]; then if grep -q ${shq(BOT_MARK)} ${shq(BOT_UNIT)}; then echo "UNIT:managed"; else echo "UNIT:foreign"; fi; else echo "UNIT:none"; fi`,
    `echo "ACTIVE:$(systemctl is-active ${BOT_SVC} 2>/dev/null | head -n1)"`,
    `echo "ENABLED:$(systemctl is-enabled ${BOT_SVC} 2>/dev/null | head -n1)"`,
    `[ -f ${shq(BOT_ENV)} ] && grep -q '^DISCORD_BOT_TOKEN=.' ${shq(BOT_ENV)} && echo "TOKEN:yes" || echo "TOKEN:no"`,
    `[ -f ${shq(BOT_ENV)} ] && grep -E '^(DISCORD_GUILD_ID|DISCORD_ALLOWED_USER_IDS|DISCORD_ALLOWED_ROLE_IDS)=' ${shq(BOT_ENV)} | sed 's/^/CFG:/'`,
    `[ -f ${shq(`${BOT_DIR}/worlds.json`)} ] && echo "WORLDS:$(base64 -w0 ${shq(`${BOT_DIR}/worlds.json`)})"`,
    'true',
  ].join('\n');
  const r = await sshExec(setup.asRootScript(script));
  const get = (k) => ((r.stdout.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1] || '').trim();
  const cfg = {};
  for (const m of r.stdout.matchAll(/^CFG:([A-Z_]+)=(.*)$/gm)) cfg[m[1]] = m[2].trim();
  let worlds = [];
  try { worlds = JSON.parse(Buffer.from(get('WORLDS') || '', 'base64').toString('utf8') || '[]'); } catch (e) { /* none */ }
  return {
    installed: get('INSTALLED') === 'yes',
    unit: get('UNIT') || 'none', // none | managed | foreign
    active: get('ACTIVE') || 'unknown',
    enabled: get('ENABLED') || 'unknown',
    hasToken: get('TOKEN') === 'yes',
    guildId: cfg.DISCORD_GUILD_ID || '',
    userIds: cfg.DISCORD_ALLOWED_USER_IDS || '',
    roleIds: cfg.DISCORD_ALLOWED_ROLE_IDS || '',
    worlds: worlds.map((w) => ({ id: w.id, label: w.label })),
  };
}

// Rewrites the worlds list the bot reads. Does nothing unless the bot was installed from here.
async function syncBotWorlds() {
  const has = await sshExec(`[ -f ${shq(`${BOT_DIR}/worlds.json`)} ] && echo YES`);
  if (!has.stdout.includes('YES')) return 0;
  const list = await botWorldList();
  await schedules.writeRootFile(`${BOT_DIR}/worlds.json`, JSON.stringify(list, null, 2) + '\n', '644');
  return list.length;
}

app.get('/api/bot', async (req, res) => {
  try {
    res.json(await botStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/install', async (req, res) => {
  const b = req.body || {};
  const token = String(b.token || '').trim();
  const guildId = String(b.guildId || '').trim();
  const idList = (v) => String(v || '').split(/[\s,]+/).filter(Boolean);
  const userIds = idList(b.userIds);
  const roleIds = idList(b.roleIds);
  const bad = (m) => sseText(res, [`[error] ${m}`], 1);
  if (token && !BOT_TOKEN_RE.test(token)) return bad('That does not look like a Discord bot token (copy it again from the Bot page of your application).');
  if (guildId && !DISCORD_ID_RE.test(guildId)) return bad('The server (guild) ID must be a number of 15-25 digits.');
  if ([...userIds, ...roleIds].some((x) => !DISCORD_ID_RE.test(x))) return bad('User and role IDs must be numbers of 15-25 digits, separated by commas.');
  if (!userIds.length && !roleIds.length) return bad('Allow at least one Discord user ID or role ID, otherwise nobody could run /codes.');
  try {
    const st = await botStatus();
    if (st.unit === 'foreign') return bad(`A service named ${BOT_SVC} that this GUI did not create is already installed. Remove or rename it on the VPS first, so two bots do not fight over one token.`);
    if (!token && !st.hasToken) return bad('Paste the bot token.');
    const worlds = await botWorldList();
    if (!worlds.length) return bad('No world is available to generate codes for.');
    await sshExec(maybeSudo(`mkdir -p ${shq(BOT_DIR)}`));
    const root = path.join(ROOT, 'vps-scripts');
    await setup.writeRootFileChunked(`${BOT_DIR}/generate-codes.py`, fs.readFileSync(path.join(root, 'generate-codes.py'), 'utf8'), '644');
    await setup.writeRootFileChunked(`${BOT_DIR}/discord-codes-bot.py`, fs.readFileSync(path.join(root, 'discord-codes-bot.py'), 'utf8'), '644');
    await schedules.writeRootFile(`${BOT_DIR}/worlds.json`, JSON.stringify(worlds, null, 2) + '\n', '644');
    const envLines = [
      `DISCORD_GUILD_ID=${guildId}`,
      `DISCORD_ALLOWED_USER_IDS=${userIds.join(',')}`,
      `DISCORD_ALLOWED_ROLE_IDS=${roleIds.join(',')}`,
      `GENERATE_CODES_SCRIPT=${BOT_DIR}/generate-codes.py`,
      `BOT_WORLDS_FILE=${BOT_DIR}/worlds.json`,
      'PYTHON_BIN=/usr/bin/python3',
    ].join('\n');
    const unit = [
      BOT_MARK + '. Edit it from Settings, Discord bot in the GUI.',
      '[Unit]',
      'Description=Valheim /codes Discord bot',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `EnvironmentFile=${BOT_ENV}`,
      `ExecStart=${BOT_DIR}/venv/bin/python ${BOT_DIR}/discord-codes-bot.py`,
      'Restart=on-failure',
      'RestartSec=15',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      'PrivateTmp=yes',
      'ProtectKernelTunables=yes',
      'ProtectControlGroups=yes',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    const script = [
      'export DEBIAN_FRONTEND=noninteractive',
      'echo "[1/4] Python tools"',
      `python3 -c 'import ensurepip, venv' 2>/dev/null || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq python3-venv >/dev/null 2>&1; }`,
      `python3 -c 'import ensurepip, venv' 2>/dev/null || { echo "[error] python3-venv could not be installed (try: apt install python3-venv)"; exit 1; }`,
      `python3 -c 'import ruamel.yaml' 2>/dev/null || { apt-get install -y -qq python3-ruamel.yaml >/dev/null 2>&1 || pip3 install --quiet --break-system-packages ruamel.yaml >/dev/null 2>&1; }`,
      `python3 -c 'import ruamel.yaml' 2>/dev/null || { echo "[error] ruamel.yaml is missing (try: apt install python3-ruamel.yaml)"; exit 1; }`,
      'echo "[2/4] discord.py in its own virtualenv"',
      `[ -x ${shq(`${BOT_DIR}/venv/bin/python`)} ] || python3 -m venv ${shq(`${BOT_DIR}/venv`)}`,
      `${shq(`${BOT_DIR}/venv/bin/pip`)} install --quiet --upgrade 'discord.py>=2.3,<3' || { echo "[error] pip could not install discord.py"; exit 1; }`,
      `${shq(`${BOT_DIR}/venv/bin/python`)} -c 'import discord; print("discord.py", discord.__version__)'`,
      'echo "[3/4] Settings and service"',
      'umask 077',
      token
        ? `TOKEN_LINE=${shq(`DISCORD_BOT_TOKEN=${token}`)}`
        : `TOKEN_LINE=$(grep '^DISCORD_BOT_TOKEN=' ${shq(BOT_ENV)} | head -n1); [ -n "$TOKEN_LINE" ] || { echo "[error] no saved bot token"; exit 1; }`,
      `{ printf '%s\\n' "$TOKEN_LINE"; printf '%s\\n' ${shq(envLines)}; } > ${shq(`${BOT_ENV}.new`)}`,
      `chown root:root ${shq(`${BOT_ENV}.new`)}; chmod 600 ${shq(`${BOT_ENV}.new`)}; mv -f ${shq(`${BOT_ENV}.new`)} ${shq(BOT_ENV)}`,
      `printf '%s' ${shq(Buffer.from(unit, 'utf8').toString('base64'))} | base64 -d > ${shq(BOT_UNIT)}; chmod 644 ${shq(BOT_UNIT)}`,
      'systemctl daemon-reload',
      `systemctl enable ${BOT_SVC} >/dev/null 2>&1`,
      `systemctl restart ${BOT_SVC}`,
      'echo "[4/4] Starting"',
      'sleep 6',
      `echo "service: $(systemctl is-active ${BOT_SVC})"`,
      `journalctl -u ${BOT_SVC} -n 6 --no-pager -o cat 2>/dev/null | sed 's/^/log: /'`,
      `systemctl is-active --quiet ${BOT_SVC} || { echo "[error] the bot is not running; see the log above"; exit 1; }`,
      'echo "Done. Type /codes in your Discord server."',
    ].join('\n');
    sshExecStream(setup.asRootScript(script), res, { idleMs: 600000 });
  } catch (e) {
    sseText(res, [`[error] ${e.message}`], 1);
  }
});

app.post('/api/bot/service', async (req, res) => {
  try {
    const action = String((req.body || {}).action || '');
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'action must be start, stop or restart' });
    const st = await botStatus();
    if (st.unit !== 'managed') return res.status(400).json({ error: st.unit === 'foreign' ? 'This bot service was not created by the GUI, so the GUI will not control it.' : 'The bot is not installed.' });
    const r = await sshExec(setup.asRootScript(`systemctl ${action} ${BOT_SVC}; sleep 2; echo "ACTIVE:$(systemctl is-active ${BOT_SVC})"`));
    res.json({ ...(await botStatus()), message: (r.stdout.match(/ACTIVE:(.*)/) || [])[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bot/logs', async (req, res) => {
  try {
    const r = await sshExec(setup.asRootScript(`journalctl -u ${BOT_SVC} -n 60 --no-pager -o short 2>&1 | tail -n 60`));
    res.json({ text: r.stdout.trim() || '(no log lines yet)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/worlds', async (req, res) => {
  try {
    const n = await syncBotWorlds();
    if (!n) return res.status(400).json({ error: 'The bot is not installed from the GUI yet.' });
    res.json({ ok: true, worlds: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/bot', async (req, res) => {
  try {
    const st = await botStatus();
    if (st.unit === 'foreign') return res.status(400).json({ error: 'This bot service was not created by the GUI, so the GUI will not remove it.' });
    const script = [
      `systemctl stop ${BOT_SVC} 2>/dev/null`,
      `systemctl disable ${BOT_SVC} >/dev/null 2>&1`,
      `rm -f ${shq(BOT_UNIT)} ${shq(BOT_ENV)} ${shq(`${BOT_ENV}.new`)}`,
      `rm -rf ${shq(BOT_DIR)}`,
      'systemctl daemon-reload',
      'echo REMOVED',
    ].join('\n');
    const r = await sshExec(setup.asRootScript(script));
    if (!r.stdout.includes('REMOVED')) throw new Error(r.stderr || 'could not remove the bot');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { syncBotWorlds });
