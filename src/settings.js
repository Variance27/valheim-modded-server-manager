// Server settings (LinuxGSM cfg) and the admin/banned/permitted lists.

const { config } = require('./context');
const { sshExec, shq, maybeSudo } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const firewall = require('./firewall');
const worldInfo = require('./world-info');
const pending = require('./pending');
const modifiers = require('./modifiers');
const players = require('./players');

// ---- Server settings + player lists (API: /api/settings, /api/lists) ----
//
// Settings live as KEY="value" lines in LGSM's common.cfg. An edit replaces the
// existing line (or appends one), after copying common.cfg to a timestamped
// .bak. Only the whitelisted keys below can be touched. Nothing is applied to
// the running game: Valheim reads these only at launch, so stop → start after.
const SETTING_DEFS = {
  servername: { label: 'Server name', type: 'text', max: 60, hint: 'Shown in the server browser.' },
  worldname: { label: 'World name', type: 'text', max: 40, pattern: /^[A-Za-z0-9._-]+$/, patternMsg: 'letters, digits, dot, dash and underscore only', hint: 'Valheim creates the world the first time the server starts. Changing it later starts a NEW world (the old one stays on disk).' },
  serverpassword: { label: 'Server password', type: 'password', min: 5, max: 64, hint: 'At least 5 characters and must not contain the world name.' },
  port: { label: 'Game port', type: 'int', minV: 1024, maxV: 65530, hint: 'UDP; the next two ports are used too.' },
  public: { label: 'Listed publicly', type: 'bool01', hint: '1 = shows in the server list, 0 = join by IP only.' },
  saveinterval: { label: 'Autosave interval (seconds)', type: 'int', minV: 60, maxV: 7200, hint: 'Valheim only writes the world on this timer and on a clean stop — 600 is a safe value.' },
  backups: { label: 'Auto-backups kept', type: 'int', minV: 1, maxV: 50, hint: 'Valheim’s own rotating world backups.' },
  backupshort: { label: 'First backup after (seconds)', type: 'int', minV: 60, maxV: 86400, hint: 'Interval of the short backups (default 7200).' },
  backuplong: { label: 'Later backups every (seconds)', type: 'int', minV: 600, maxV: 604800, hint: 'Interval of the long backups (default 43200).' },
  // Edited through the World modifiers card (/api/modifiers), not the generic form.
  worldmodifiers: { label: 'World modifiers', type: 'text', max: 300, allowEmpty: true, hidden: true },
};
const WEAK_PASSWORDS = new Set(['qwerty1234', 'password', 'password1', '12345678', '123456789', '1234567890', 'valheim', 'valheim123', 'qwerty', 'qwerty123']);

function parseCfgValue(text, key) {
  // Last active (non-comment) assignment wins, like the shell would treat it.
  const re = new RegExp(`^[ \\t]*${key}=(?:"((?:[^"\\\\\\n]|\\\\.)*)"|'([^'\\n]*)'|([^\\s#]*))`, 'gm');
  let m;
  let val = null;
  while ((m = re.exec(text))) val = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return val;
}

function cfgFilesToSearch() {
  const common = config.paths.commonCfgPath;
  if (!common) return [];
  // LGSM merges common.cfg and (optionally) <server>.cfg; the instance cfg wins.
  const instance = common.replace(/common\.cfg$/, `${config.lgsmServer || 'vhserver'}.cfg`);
  return instance !== common ? [common, instance] : [common];
}
// LGSM's shipped defaults: lowest priority, read-only (overwritten on LGSM updates).
function defaultCfgFile() {
  const common = config.paths.commonCfgPath;
  return common ? common.replace(/common\.cfg$/, '_default.cfg') : null;
}

app.get('/api/settings', async (req, res) => {
  try {
    const files = cfgFilesToSearch();
    if (!files.length) return res.status(400).json({ error: 'paths.commonCfgPath is not set in config.json' });
    const texts = {};
    for (const f of files) texts[f] = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
    if (!texts[files[0]]) return res.status(400).json({ error: `Can't read ${files[0]} — LinuxGSM isn't installed yet (use the Setup tab) or paths.commonCfgPath is wrong.` });
    const dflt = defaultCfgFile();
    const dfltText = dflt && dflt !== files[0] ? (await sshExec(`cat ${shq(dflt)} 2>/dev/null`)).stdout : '';
    const settings = {};
    let startparams = null;
    for (const key of Object.keys(SETTING_DEFS)) {
      let value = null;
      let source = null;
      if (dfltText) {
        const dv = parseCfgValue(dfltText, key);
        if (dv !== null) { value = dv; source = 'LGSM default'; }
      }
      for (const f of files) {
        const v = parseCfgValue(texts[f], key);
        if (v !== null) { value = v; source = f; }
      }
      settings[key] = { ...SETTING_DEFS[key], value, source };
    }
    if (dfltText) startparams = parseCfgValue(dfltText, 'startparameters');
    for (const f of files) {
      const v = parseCfgValue(texts[f], 'startparameters');
      if (v !== null) startparams = v;
    }
    const usesVar = (k) => (startparams ? new RegExp('\\$\\{?' + k + '(?![A-Za-z0-9_])').test(startparams) : null);
    for (const key of Object.keys(settings)) settings[key].usedByStartParameters = usesVar(key);
    const wi = await worldInfo.getWorldInfo();
    const pw = settings.serverpassword.value;
    res.json({
      settings,
      writeTo: files[0],
      worldName: wi.world,
      worldNameOverride: config.worldName || null,
      passwordWarning: pw && WEAK_PASSWORDS.has(pw.toLowerCase()) ? 'This password is on the list of very common passwords — anyone who finds the server can guess it.' : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const incoming = (req.body && req.body.values) || {};
    const clean = {};
    for (const [key, raw] of Object.entries(incoming)) {
      const def = SETTING_DEFS[key];
      if (!def) return res.status(400).json({ error: `Unknown setting: ${key}` });
      const v = String(raw == null ? '' : raw).trim();
      if (def.type === 'int') {
        if (!/^\d+$/.test(v) || Number(v) < def.minV || Number(v) > def.maxV) return res.status(400).json({ error: `${def.label} must be a whole number between ${def.minV} and ${def.maxV}.` });
      } else if (def.type === 'bool01') {
        if (v !== '0' && v !== '1') return res.status(400).json({ error: `${def.label} must be 0 or 1.` });
      } else {
        if ((!v && !def.allowEmpty) || v.length > def.max) return res.status(400).json({ error: `${def.label} must be 1–${def.max} characters.` });
        if (/["'`$\\\n\r]/.test(v)) return res.status(400).json({ error: `${def.label} can't contain quotes, backslashes or $ (they break the launch command).` });
        if (def.pattern && !def.pattern.test(v)) return res.status(400).json({ error: `${def.label}: ${def.patternMsg}.` });
        if (key === 'serverpassword' && v.length < def.min) return res.status(400).json({ error: 'The server password must be at least 5 characters.' });
      }
      clean[key] = v;
    }
    const keys = Object.keys(clean);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
    if (clean.port !== undefined) {
      // Each world on this VPS needs its own game port (Valheim also uses the next two).
      const clash = (await worldsPage.otherWorldPorts()).find((o) => worldsPage.portsOverlap(o.port, clean.port));
      if (clash) return res.status(400).json({ error: `Game port ${clean.port} overlaps the world "${clash.label}" (port ${clash.port}). Valheim also uses the next two ports, so keep worlds at least 3 apart.` });
    }
    if (clean.serverpassword !== undefined || clean.worldname !== undefined) {
      // Valheim refuses to start when the password contains the world name; check the
      // pair as it will be after this save (the one being saved, else what is set now).
      const world = clean.worldname !== undefined ? clean.worldname : (await worldInfo.getWorldInfo()).world;
      const pw = clean.serverpassword !== undefined ? clean.serverpassword : (await modifiers.readEffectiveCfgValue('serverpassword')) || '';
      if (pw && world && pw.toLowerCase().includes(world.toLowerCase())) {
        return res.status(400).json({ error: 'Valheim refuses a password that contains the world name. Change one of them.' });
      }
    }
    const oldPort = clean.port !== undefined ? await firewall.worldGamePort().catch(() => null) : null;
    const out = await applyCfgValues(clean);
    worldInfo.invalidateWorldInfo();
    if (out.applied) pending.notePending(`Server settings changed (${keys.filter((k) => k !== 'worldmodifiers').join(', ') || 'world modifiers'})`);
    // A changed game port: open the new UDP range and close the one this GUI opened for the old port.
    // Firewall trouble never fails the settings save.
    if (clean.port !== undefined && out.applied) {
      try {
        const fw = await firewall.fwRun('open', Number(clean.port));
        if (oldPort && Number(oldPort) !== Number(clean.port) && fw.active) {
          const old = await firewall.fwRun('close-tagged', oldPort);
          if (old.result === 'closed') fw.message += ` ${old.message}`;
        }
        out.firewall = fw;
      } catch (e) {
        out.firewall = { tool: 'none', message: `Firewall not changed: ${e.message}` };
      }
    }
    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Writes already-validated KEY="value" pairs into the LGSM cfg that currently wins
// for each key (common.cfg by default), with a timestamped .bak of every file touched.
async function applyCfgValues(clean) {
  const keys = Object.keys(clean);
  const fail = (msg, code) => Object.assign(new Error(msg), { statusCode: code || 500 });
  const files = cfgFilesToSearch();
  if (!files.length) throw fail('paths.commonCfgPath is not set in config.json', 400);
  const texts = {};
  for (const f of files) texts[f] = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
  if (!texts[files[0]]) throw fail(`couldn't read ${files[0]}`, 400);
  // Each key is written to the file that currently wins for it (the instance
  // cfg overrides common.cfg); keys set nowhere go to common.cfg.
  const nextText = { ...texts };
  const touched = new Set();
  for (const key of keys) {
    let target = files[0];
    for (const f of files) if (parseCfgValue(texts[f], key) !== null) target = f;
    let next = nextText[target] || '';
    const line = `${key}="${clean[key]}"`;
    const all = [...next.matchAll(new RegExp(`^[ \\t]*${key}=.*$`, 'gm'))];
    if (all.length) {
      const last = all[all.length - 1];
      next = next.slice(0, last.index) + line + next.slice(last.index + last[0].length);
    } else {
      next = next.replace(/\n*$/, '\n') + line + '\n';
    }
    nextText[target] = next;
    touched.add(target);
  }
  const backups = [];
  for (const target of touched) {
    if (nextText[target] === texts[target]) continue;
    const backupPath = `${target}.bak.${Date.now()}`;
    const b64 = Buffer.from(nextText[target], 'utf8').toString('base64');
    const cmd = [
      `if [ -f ${shq(target)} ]; then ${maybeSudo(`cp -p ${shq(target)} ${shq(backupPath)}`)}; fi`,
      `printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${shq(target)}`)} >/dev/null`,
      'echo APPLIED',
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) throw fail(`write to ${target} failed: ${r.stdout} ${r.stderr}`);
    backups.push(backupPath);
  }
  if (!backups.length) return { applied: false, note: 'No changes.' };
  return { applied: true, changed: keys, backups, note: 'Saved. Stop and start the server to apply (Valheim reads these only at launch).' };
}

const LIST_FILES = { admin: 'adminlist.txt', banned: 'bannedlist.txt', permitted: 'permittedlist.txt' };
function listDir() {
  const user = config.lgsmUser || 'vhserver';
  return (config.paths && config.paths.listDir) || `/home/${user}/.config/unity3d/IronGate/Valheim`;
}
const STEAMID = /^\d{17}$/;

function parseList(text) {
  // Valheim format: one ID per line; lines starting with // are comments (the
  // game writes the header and uses "// name" after IDs it knows).
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map((l) => {
    const [id, ...rest] = l.split(/\s+/);
    return { id, note: rest.join(' ').replace(/^\/\/\s*/, '') };
  });
}

app.get('/api/lists', async (req, res) => {
  try {
    const dir = listDir();
    const out = {};
    for (const [k, f] of Object.entries(LIST_FILES)) {
      const r = await sshExec(`cat ${shq(`${dir}/${f}`)} 2>/dev/null`);
      out[k] = parseList(r.stdout);
    }
    res.json({ dir, lists: out, players: await players.getOnlinePlayers().catch(() => []) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replaces one whole list. Backs the old file up first. Valheim re-reads these
// files while running (about every minute), so no restart is needed.
app.post('/api/lists/:which', async (req, res) => {
  try {
    const file = LIST_FILES[req.params.which];
    if (!file) return res.status(404).json({ error: 'Unknown list' });
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'entries must be an array' });
    if (entries.length > 500) return res.status(400).json({ error: 'Too many entries' });
    const seen = new Set();
    const lines = [];
    for (const e of entries) {
      const id = String((e && e.id) || '').trim();
      if (!STEAMID.test(id)) return res.status(400).json({ error: `"${id}" is not a 17-digit SteamID64.` });
      if (seen.has(id)) continue;
      seen.add(id);
      const note = String((e && e.note) || '').replace(/[\r\n]/g, ' ').trim().slice(0, 60);
      lines.push(note ? `${id} // ${note}` : id);
    }
    const dir = listDir();
    const target = `${dir}/${file}`;
    const header = `//List of ${req.params.which === 'admin' ? 'admin' : req.params.which === 'banned' ? 'banned' : 'permitted'} players ID ONLY ONE per line\n`;
    const b64 = Buffer.from(header + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8').toString('base64');
    const user = config.lgsmUser || 'vhserver';
    const cmd = [
      `if [ -f ${shq(target)} ]; then ${maybeSudo(`cp -p ${shq(target)} ${shq(`${target}.bak.${Date.now()}`)}`)}; fi`,
      `cd ${shq(`/home/${user}`)} && printf '%s' ${shq(b64)} | base64 -d | sudo -n -u ${shq(user)} tee ${shq(target)} >/dev/null`,
      'echo APPLIED',
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) return res.status(500).json({ error: `write failed: ${r.stdout} ${r.stderr}` });
    res.json({ applied: true, count: lines.length, note: 'Saved. Valheim re-reads the lists on its own within about a minute.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

Object.assign(module.exports, { defaultCfgFile, cfgFilesToSearch, parseCfgValue, applyCfgValues, WEAK_PASSWORDS });
