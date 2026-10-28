// Valheim Server GUI. Every feature lives in its own file under src/; this file loads them and starts
// the web server. See CLAUDE.md for how the parts fit together.

const { config, runtime } = require('./src/context');
const { LOCAL_MODE, getSharedConn } = require('./src/exec');
const { app } = require('./src/app');
const packageCache = require('./src/package-cache');
const modCatalog = require('./src/mod-catalog');

// Load every feature. Each file registers its own routes as it loads. A file may load another one
// first (the files use each other), so this is the order of the original single file, not
// necessarily the order routes end up in. No two routes overlap, so that order does not matter.
require('./src/server-control');
require('./src/worlds-page');
require('./src/migration');
require('./src/firewall');
require('./src/world-removal');
require('./src/dashboard');
require('./src/backups');
require('./src/world-info');
require('./src/schedules');
require('./src/notify');
require('./src/health-alerts');
require('./src/discord');
require('./src/bot');
require('./src/settings');
require('./src/pending');
require('./src/modifiers');
require('./src/mod-configs');
require('./src/updates');
require('./src/mod-data');
require('./src/package-cache');
require('./src/mod-catalog');
require('./src/mod-actions');
require('./src/players');
require('./src/logs');
require('./src/setup');
require('./src/pz');

// ---- Start ----

const PORT = config.guiPort || 4173;
// Bind to localhost only. Without an explicit host, Node listens on ALL
// network interfaces — meaning anyone on your LAN (or the internet, if this
// port is ever forwarded) could reach this with zero login and full control,
// including your VPS root password sitting in config.json. There is no
// legitimate reason for this to be reachable from anywhere but this machine.
// Keep this on 127.0.0.1. To reach a GUI running on the VPS, use an SSH
// tunnel or Tailscale Serve — both forward to this localhost port without
// exposing it to the internet.
const BIND_HOST = config.bindHost || '127.0.0.1';
const httpServer = app.listen(PORT, BIND_HOST, () => {
  runtime.serving = true;
  console.log(`Valheim GUI running at http://${BIND_HOST === '127.0.0.1' ? 'localhost' : BIND_HOST}:${PORT} (mode: ${LOCAL_MODE ? 'local, on this machine' : 'ssh → ' + config.ssh.host})`);
  // Warm the package-list caches and the shared SSH connection in the
  // background so the first Mods-tab load doesn't pay for them.
  packageCache.getThunderstorePackages().catch((e) => console.error('[pkg-cache] thunderstore warm-up failed:', e.message));
  modCatalog.getHexiumPackages().catch(() => {});
  getSharedConn().catch((e) => console.error('[ssh] initial connection failed:', e.message));
});
// A migration bundle can be several GB; the default 5 minute limit on receiving one request would cut the upload off.
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
