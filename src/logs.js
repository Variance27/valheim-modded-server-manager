// Logs: snapshots and live follow.

const { config } = require('./context');
const { sshExec, shq, sshExecFollow } = require('./exec');
const { app } = require('./app');

// ---- Logs ----

app.get('/api/logs/tail', async (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(config.paths.logFile)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Named "journal" for backward compatibility with the frontend's existing
// source selector, but there is no systemd journal anymore — this now
// tails LGSM's own console log (config.paths.consoleLog), which is what
// captures the game process's raw stdout/stderr under LGSM.
app.get('/api/logs/journal', async (req, res) => {
  const lines = parseInt(req.query.lines, 10) || 200;
  try {
    const r = await sshExec(`tail -n ${lines} ${shq(config.paths.consoleLog)} 2>/dev/null`);
    res.json({ text: r.stdout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live-follow either the LGSM console log ("journal", by legacy name) or the
// BepInEx log file.
app.get('/api/logs/live', (req, res) => {
  const source = req.query.source === 'tail' ? 'tail' : 'journal';
  const cmd =
    source === 'tail'
      ? `tail -n 20 -F ${shq(config.paths.logFile)}`
      : `tail -n 20 -F ${shq(config.paths.consoleLog)}`;
  sshExecFollow(cmd, req, res);
});
