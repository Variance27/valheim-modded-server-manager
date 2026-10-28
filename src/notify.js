// Discord webhook settings (notifications.json).

const fs = require('fs');
const path = require('path');
const { ROOT, config } = require('./context');

// ---- Discord webhook settings (notifications.json) ----

// Discord webhooks. Two channels: "changes" (the Mods tab's "Notify Discord" summaries) and "status"
// (cron-job alerts: backup failures, server restarted after backup, update available; falls back to the
// changes channel when unset). The Settings tab saves them to notifications.json (git-ignored, mode 600);
// a value saved there wins over discordWebhookUrl / discordStatusWebhookUrl in config.json, which
// stay valid as the starting point.
const NOTIFY_PATH = path.join(ROOT, 'notifications.json');
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;
function readNotify() {
  try {
    const j = JSON.parse(fs.readFileSync(NOTIFY_PATH, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}
function writeNotify(obj) {
  fs.writeFileSync(NOTIFY_PATH, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(NOTIFY_PATH, 0o600); } catch (e) { /* best effort (Windows) */ }
}
function changesWebhook() {
  const n = readNotify();
  return typeof n.changesWebhookUrl === 'string' ? n.changesWebhookUrl : config.discordWebhookUrl || '';
}
function ownStatusWebhook() {
  const n = readNotify();
  return typeof n.statusWebhookUrl === 'string' ? n.statusWebhookUrl : config.discordStatusWebhookUrl || '';
}
function statusWebhook() {
  return ownStatusWebhook() || changesWebhook();
}

Object.assign(module.exports, { changesWebhook, statusWebhook, readNotify, ownStatusWebhook, writeNotify, WEBHOOK_RE });
