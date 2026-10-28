// Valheim server updates.

const { config } = require('./context');
const { sshExecStream, shq, maybeSudo } = require('./exec');
const { app } = require('./app');

// ---- Updates ----

app.get('/api/update/check', (req, res) => {
  sshExecStream(`bash ${shq(config.paths.checkUpdateScript)}`, res);
});

app.get('/api/update/apply', (req, res) => {
  sshExecStream(maybeSudo(`bash ${shq(config.paths.applyUpdateScript)}`), res, { idleMs: 600000 });
});
