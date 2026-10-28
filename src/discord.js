// Discord webhook settings page.

const { config } = require('./context');
const { readNotify, changesWebhook, ownStatusWebhook, statusWebhook, writeNotify, WEBHOOK_RE } = require('./notify');
const { sshExec, maybeSudo, shq, postWebhook } = require('./exec');
const { app } = require('./app');
const worldsPage = require('./worlds-page');
const worldInfo = require('./world-info');
const schedules = require('./schedules');
const healthAlerts = require('./health-alerts');
const setup = require('./setup');

// ---- Discord webhooks (API: /api/discord) ----
function maskWebhook(u) {
  const m = /\/webhooks\/(\d+)\//.exec(u || '');
  return u ? `discord.com/api/webhooks/${m ? m[1] : '…'}/••••${u.slice(-4)}` : '';
}
function discordState() {
  const n = readNotify();
  const src = (fileKey, cfgVal) => (typeof n[fileKey] === 'string' ? 'GUI' : cfgVal ? 'config.json' : 'none');
  const ch = changesWebhook();
  const stOwn = ownStatusWebhook();
  return {
    changes: { set: !!ch, masked: maskWebhook(ch), source: src('changesWebhookUrl', config.discordWebhookUrl) },
    status: { set: !!stOwn, masked: maskWebhook(stOwn), source: src('statusWebhookUrl', config.discordStatusWebhookUrl), usingChanges: !stOwn && !!ch },
  };
}

// Pushes the status webhook into one world's VPS-side pieces: the backup and update-check cron
// wrappers (their URL is written into the script) and valheim-notify.conf (read by the backup,
// update-check and update scripts when you run them by hand).
async function applyStatusWebhookToWorld() {
  const done = [];
  const here = await sshExec(`${maybeSudo(`test -x ${shq(config.paths.lgsmScript)}`)} && echo YES`);
  if (!here.stdout.includes('YES')) return 'not installed yet, skipped';
  for (const kind of ['backup', 'update']) {
    const cur = await schedules.readCronJob(kind);
    if (!cur.enabled) continue;
    await schedules.installCronJob(kind, true, cur.intervalHours, cur.onlyWhenEmpty);
    done.push(`${kind} schedule refreshed`);
  }
  const health = await healthAlerts.readHealthJob();
  if (health.enabled) {
    await healthAlerts.installHealthJob(health);
    done.push('health alerts refreshed');
  }
  const url = statusWebhook();
  const f = `${config.lgsmHome}/.config/valheim-notify.conf`;
  const script = [
    `F=${shq(f)}`,
    `U=${shq(config.lgsmUser)}`,
    '[ -d "$(dirname "$F")" ] || { echo SKIP; exit 0; }',
    url ? '[ -f "$F" ] || touch "$F"' : '[ -f "$F" ] || { echo SKIP; exit 0; }',
    'T=$(mktemp)',
    `grep -Ev '^[[:space:]]*(export[[:space:]]+)?DISCORD_WEBHOOK_URL=' "$F" > "$T" || true`,
    url ? `printf '%s\\n' ${shq(`DISCORD_WEBHOOK_URL='${url}'`)} >> "$T"` : ':',
    'cat "$T" > "$F"; rm -f "$T"',
    'chown "$U":"$U" "$F" 2>/dev/null || true',
    'chmod 600 "$F"',
    'echo SYNCED',
  ].join('\n');
  const r = await sshExec(setup.asRootScript(script));
  if (r.stdout.includes('SYNCED')) done.push('valheim-notify.conf updated');
  return done.length ? done.join(', ') : 'nothing to change';
}

app.get('/api/discord', (req, res) => res.json(discordState()));

app.post('/api/discord', async (req, res) => {
  try {
    const body = req.body || {};
    const next = readNotify();
    const before = statusWebhook();
    for (const [field, key] of [['changes', 'changesWebhookUrl'], ['status', 'statusWebhookUrl']]) {
      if (body[field] === undefined) continue;
      const v = String(body[field]).trim();
      if (v && !WEBHOOK_RE.test(v)) {
        return res.status(400).json({ error: `The ${field} webhook is not a Discord webhook URL (it should look like https://discord.com/api/webhooks/<id>/<token>).` });
      }
      next[key] = v;
    }
    writeNotify(next);
    const applied = [];
    if (statusWebhook() !== before) {
      for (const id of worldsPage.worldList()) {
        try {
          const msg = await worldsPage.inWorld(id, async () => ({ world: config.instance.label, message: await applyStatusWebhookToWorld() }));
          applied.push({ ...msg, ok: true });
        } catch (e) {
          applied.push({ world: id, ok: false, message: e.message });
        }
      }
    }
    res.json({ ...discordState(), applied });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/discord/test', async (req, res) => {
  const which = (req.body || {}).which === 'status' ? 'status' : 'changes';
  const typed = String((req.body || {}).url || '').trim();
  if (typed && !WEBHOOK_RE.test(typed)) return res.json({ ok: false, error: 'That is not a Discord webhook URL.' });
  const url = typed || (which === 'status' ? statusWebhook() : changesWebhook());
  if (!url) return res.json({ ok: false, error: 'No webhook URL is set for this channel.' });
  const brand = (await worldInfo.getWorldInfo()).brand;
  const ok = await postWebhook(url, `✅ Test message from the ${brand} server manager (${which} channel). If you can read this, the webhook works.`);
  res.json({ ok, error: ok ? undefined : 'Discord rejected the message or was unreachable. Check the URL (the webhook may have been deleted).' });
});
