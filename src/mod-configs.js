// Mod config editor (BepInEx config/*.cfg).

const path = require('path');
const { config } = require('./context');
const { sshExec, shq, maybeSudo } = require('./exec');
const { app } = require('./app');
const pending = require('./pending');

// ---- Mod config editor (API: /api/configs) ----
//
// BepInEx plugin configs (BepInEx/config/*.cfg). The parser reads the "## description",
// "# Setting type", "# Default value", "# Acceptable values/range" comments the game's
// BepInEx writes above each entry, so the editor can show proper inputs. Edits replace
// only the value on an existing "Key = value" line (comments and layout are untouched)
// and keep a timestamped .bak (newest 5 kept per file). Needs a Stop -> Start to apply.
function bepinexConfigDir() {
  const p = config.paths || {};
  if (p.bepinexConfigDir) return p.bepinexConfigDir;
  if (p.pluginsDir) return path.posix.join(path.posix.dirname(p.pluginsDir), 'config');
  return null;
}
const CFG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ \-]*\.cfg$/;

function parseBepinexCfg(text) {
  const lines = text.split('\n');
  const entries = [];
  let section = '';
  let meta = { desc: [], type: '', def: '', accept: '', range: '' };
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    let m;
    if ((m = line.match(/^\[(.+)\]\s*$/))) { section = m[1]; meta = { desc: [], type: '', def: '', accept: '', range: '' }; return; }
    if (/^\s*$/.test(line)) { meta = { desc: [], type: '', def: '', accept: '', range: '' }; return; }
    if (line.startsWith('##')) { meta.desc.push(line.replace(/^##\s?/, '')); return; }
    if (line.startsWith('#')) {
      if ((m = line.match(/^# Setting type:\s*(.+)$/))) meta.type = m[1].trim();
      else if ((m = line.match(/^# Default value:\s*(.*)$/))) meta.def = m[1].trim();
      else if ((m = line.match(/^# Acceptable values:\s*(.+)$/))) meta.accept = m[1].trim();
      else if ((m = line.match(/^# Acceptable value range:\s*(.+)$/))) meta.range = m[1].trim();
      else meta.desc.push(line.replace(/^#\s?/, ''));
      return;
    }
    if ((m = line.match(/^([^=#\[][^=]*?)\s*=\s?(.*)$/))) {
      entries.push({
        line: idx, section, key: m[1].trim(), value: m[2],
        description: meta.desc.join('\n').trim(), type: meta.type, default: meta.def,
        acceptable: meta.accept ? meta.accept.split(/,\s*/) : null, range: meta.range || null,
      });
      meta = { desc: [], type: '', def: '', accept: '', range: '' };
    }
  });
  return entries;
}

function validateCfgValue(entry, value) {
  const t = (entry.type || '').toLowerCase();
  const v = String(value);
  if (/[\r\n]/.test(v)) return 'Value cannot contain a line break.';
  if (t === 'boolean') return /^(true|false)$/i.test(v) ? null : 'Must be true or false.';
  if (['int32', 'int', 'int64', 'byte', 'uint32', 'uint16'].includes(t)) { if (!/^-?\d+$/.test(v)) return 'Must be a whole number.'; }
  else if (['single', 'float', 'double', 'decimal'].includes(t)) { if (!/^-?\d+([.,]\d+)?(e[+-]?\d+)?$/i.test(v)) return 'Must be a number.'; }
  const rm = entry.range && entry.range.match(/From\s+(-?[\d.eE+-]+)\s+to\s+(-?[\d.eE+-]+)/i);
  if (rm && /^-?\d/.test(v)) {
    const n = parseFloat(v.replace(',', '.'));
    if (n < parseFloat(rm[1]) || n > parseFloat(rm[2])) return `Must be between ${rm[1]} and ${rm[2]}.`;
  }
  if (entry.acceptable && !/flags/i.test(entry.description || '') && entry.acceptable.length && !entry.acceptable.some((a) => a.toLowerCase() === v.trim().toLowerCase())) {
    return `Must be one of: ${entry.acceptable.join(', ')}.`;
  }
  return null;
}

app.get('/api/configs', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    if (!dir) return res.status(400).json({ error: 'paths.pluginsDir (or paths.bepinexConfigDir) is not set in config.json' });
    const r = await sshExec(`find ${shq(dir)} -maxdepth 1 -type f -name '*.cfg' -printf '%f\\t%s\\t%T@\\n' 2>/dev/null | sort -f`);
    const files = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [name, size, mtime] = l.split('\t');
      return { name, size: Number(size), mtime: Math.round(Number(mtime) * 1000) };
    });
    res.json({ dir, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/configs/file', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    const name = String(req.query.name || '');
    if (!dir || !CFG_FILE_RE.test(name)) return res.status(400).json({ error: 'Invalid config file name.' });
    const r = await sshExec(`cat ${shq(`${dir}/${name}`)} 2>/dev/null`);
    if (!r.stdout) return res.status(404).json({ error: `${name} is empty or could not be read.` });
    res.json({ name, entries: parseBepinexCfg(r.stdout) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/configs/file', async (req, res) => {
  try {
    const dir = bepinexConfigDir();
    const { name, changes } = req.body || {};
    if (!dir || !CFG_FILE_RE.test(String(name || ''))) return res.status(400).json({ error: 'Invalid config file name.' });
    if (!Array.isArray(changes) || !changes.length) return res.status(400).json({ error: 'No changes.' });
    if (changes.length > 400) return res.status(400).json({ error: 'Too many changes.' });
    const target = `${dir}/${name}`;
    const cur = (await sshExec(`cat ${shq(target)} 2>/dev/null`)).stdout;
    if (!cur) return res.status(404).json({ error: `${name} could not be read.` });
    const entries = parseBepinexCfg(cur);
    const lines = cur.split('\n');
    const crlf = /\r\n/.test(cur);
    let changed = 0;
    for (const c of changes) {
      const e = entries.find((x) => x.section === c.section && x.key === c.key);
      if (!e) return res.status(400).json({ error: `Setting not found: [${c.section}] ${c.key}` });
      const val = String(c.value == null ? '' : c.value);
      const bad = validateCfgValue(e, val);
      if (bad) return res.status(400).json({ error: `[${e.section}] ${e.key}: ${bad}` });
      const old = lines[e.line].replace(/\r$/, '');
      const eq = old.indexOf('=');
      const next = `${old.slice(0, eq).replace(/\s+$/, '')} = ${val}`;
      if (next !== old) { lines[e.line] = next + (crlf ? '\r' : ''); changed++; }
    }
    if (!changed) return res.json({ applied: false, note: 'No changes.' });
    const user = config.lgsmUser || 'vhserver';
    const b64 = Buffer.from(lines.join('\n'), 'utf8').toString('base64');
    const bak = `${target}.bak.${Date.now()}`;
    const cmd = [
      maybeSudo(`cp -p ${shq(target)} ${shq(bak)}`),
      `cd ${shq(`/home/${user}`)} && printf '%s' ${shq(b64)} | base64 -d | sudo -n -u ${shq(user)} tee ${shq(target)} >/dev/null`,
      `(ls -1t ${shq(target)}.bak.* 2>/dev/null | tail -n +6 | while read -r f; do ${maybeSudo('rm -f "$f"')}; done; true)`,
      'echo APPLIED',
    ].join(' && ');
    const out = await sshExec(cmd);
    if (!out.stdout.includes('APPLIED')) return res.status(500).json({ error: `write failed: ${out.stdout} ${out.stderr}` });
    pending.notePending(`Mod config edited: ${name}`);
    res.json({ applied: true, changed, backup: bak, note: 'Saved. Stop and start the server to apply.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
