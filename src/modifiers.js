// World modifiers (Settings page).

const { sshExec, shq } = require('./exec');
const { app } = require('./app');
const settings = require('./settings');
const pending = require('./pending');

// ---- World modifiers (API: GET/POST /api/modifiers) ----
//
// Stored in LGSM's `worldmodifiers` variable, which your startparameters append to
// the launch line. Valheim flags: -preset <name>, -modifier <key> <value>, -setkey <key>.
const WM_PRESETS = ['normal', 'casual', 'easy', 'hard', 'hardcore', 'immersive', 'hammer'];
const WM_MODIFIERS = {
  combat: ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources: ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids: ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals: ['casual', 'hard', 'veryhard'],
};
const WM_KEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];

function parseWorldModifiers(str) {
  const out = { preset: '', modifiers: {}, keys: [], extra: '' };
  const toks = String(str || '').split(/\s+/).filter(Boolean);
  const extra = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    if (t === '-preset' && toks[i + 1]) out.preset = toks[++i].toLowerCase();
    else if (t === '-modifier' && toks[i + 2]) { const k = toks[++i].toLowerCase(); out.modifiers[k] = toks[++i].toLowerCase(); }
    else if (t === '-setkey' && toks[i + 1]) out.keys.push(toks[++i].toLowerCase());
    else extra.push(toks[i]);
  }
  out.extra = extra.join(' ');
  return out;
}

async function readEffectiveCfgValue(key) {
  const files = settings.cfgFilesToSearch();
  const dflt = settings.defaultCfgFile();
  let value = null;
  const order = [dflt && dflt !== files[0] ? dflt : null, ...files].filter(Boolean);
  for (const f of order) {
    const t = (await sshExec(`cat ${shq(f)} 2>/dev/null`)).stdout;
    const v = settings.parseCfgValue(t, key);
    if (v !== null) value = v;
  }
  return value;
}

app.get('/api/modifiers', async (req, res) => {
  try {
    if (!settings.cfgFilesToSearch().length) return res.status(400).json({ error: 'paths.commonCfgPath is not set in config.json' });
    const raw = (await readEffectiveCfgValue('worldmodifiers')) || '';
    res.json({ ...parseWorldModifiers(raw), options: { presets: WM_PRESETS, modifiers: WM_MODIFIERS, keys: WM_KEYS } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/modifiers', async (req, res) => {
  try {
    const b = req.body || {};
    const preset = String(b.preset || '').toLowerCase();
    if (preset && !WM_PRESETS.includes(preset)) return res.status(400).json({ error: `Unknown preset: ${preset}` });
    const parts = [];
    if (preset) parts.push(`-preset ${preset}`);
    for (const [k, v] of Object.entries(b.modifiers || {})) {
      if (!v) continue;
      if (!WM_MODIFIERS[k]) return res.status(400).json({ error: `Unknown modifier: ${k}` });
      if (!WM_MODIFIERS[k].includes(String(v))) return res.status(400).json({ error: `Invalid value for ${k}: ${v}` });
      parts.push(`-modifier ${k} ${v}`);
    }
    for (const k of b.keys || []) {
      if (!WM_KEYS.includes(k)) return res.status(400).json({ error: `Unknown world key: ${k}` });
      parts.push(`-setkey ${k}`);
    }
    const extra = String(b.extra || '').trim();
    if (extra && !/^[A-Za-z0-9 _.\-]*$/.test(extra)) return res.status(400).json({ error: 'Other launch options contain unsupported characters.' });
    if (extra) parts.push(extra);
    const value = parts.join(' ');
    const out = await settings.applyCfgValues({ worldmodifiers: value });
    if (out.applied) pending.notePending('World modifiers changed');
    res.json({ ...out, value });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

Object.assign(module.exports, { readEffectiveCfgValue });
