// Players online, parsed from the BepInEx log.

const { config } = require('./context');
const { sshExec, shq, Client, sshConnectOpts, followCmd } = require('./exec');
const { app } = require('./app');

// ---- Players (parsed from the BepInEx log — Valheim has no built-in RCON) ----
//
// Valheim logs a join and a leave with DIFFERENT identifiers:
//   join:  "Got connection SteamID 7656119…"           (network id)
//          "Got character ZDOID from Alice : 12345:1"   (character name)
//   leave: "Closing socket 7656119…"                   (network id only!)
// The old parser keyed joins by character name and leaves by the socket id,
// so a leave never matched anyone and players stayed "online" until the
// log rotated. PlayerTracker links each character name to the connection
// id that preceded it, so the matching "Closing socket" line removes them.
// It also resets on a server (re)start ("Load world") and trusts Valheim's
// own periodic "Connections N ZDOS:" line when it reports 0 connections.
// Crossplay (PlayFab) builds log "Platform ID Steam_7656…" style ids — those
// are handled too.
class PlayerTracker {
  constructor() {
    this.online = new Map(); // name -> { id, since }
    this.pending = []; // connection ids seen but not yet linked to a character
    // Join times are only known for joins seen live; joins replayed from the
    // log history (seed) get null, since the log lines carry no reliable timezone.
    this.live = false;
  }
  _normId(id) {
    return String(id || '').trim().replace(/^(Steam_|steam_)/, '');
  }
  // Returns true if the roster changed.
  feed(line) {
    let m;
    if (/Load world:|Starting to load scene/.test(line)) {
      const changed = this.online.size > 0;
      this.online.clear();
      this.pending = [];
      return changed;
    }
    if ((m = line.match(/Got connection SteamID (\d+)/)) || (m = line.match(/received local Platform ID (\S+)/))) {
      const id = this._normId(m[1]);
      if (!this.pending.includes(id)) this.pending.push(id);
      if (this.pending.length > 20) this.pending.shift();
      return false;
    }
    if ((m = line.match(/Got character ZDOID from (.+?) : (-?\d+):(\d+)/))) {
      const name = m[1].trim();
      if (m[2] === '0') return false; // ZDOID 0:0 = the character died; they're still connected
      if (this.online.has(name)) return false; // respawn / re-sent — already tracked
      const id = this.pending.shift() || null;
      this.online.set(name, { id, since: this.live ? Date.now() : null });
      return true;
    }
    if ((m = line.match(/Closing socket (\S+)/)) || (m = line.match(/Disposing socket (\S+)/))) {
      const id = this._normId(m[1]);
      this.pending = this.pending.filter((p) => p !== id);
      for (const [name, info] of this.online) {
        if (info.id && info.id === id) {
          this.online.delete(name);
          return true;
        }
      }
      return false;
    }
    if ((m = line.match(/Connections (\d+) ZDOS:/))) {
      if (m[1] === '0' && this.online.size) {
        this.online.clear();
        this.pending = [];
        return true;
      }
      return false;
    }
    return false;
  }
  list() {
    return Array.from(this.online.keys());
  }
  details() {
    return Array.from(this.online.entries()).map(([name, info]) => ({ name, since: info.since }));
  }
}

const PLAYER_LINE_PATTERN =
  'Got character ZDOID from|Closing socket|Disposing socket|Got connection SteamID|received local Platform ID|Load world:|Starting to load scene|Connections [0-9]+ ZDOS:';

// Look at the tail of the log for connect/disconnect lines and derive who's
// currently on. Still a heuristic (log-based), not an authoritative list.
async function getOnlinePlayers() {
  const r = await sshExec(`tail -n 20000 ${shq(config.paths.logFile)} 2>/dev/null | grep -E ${shq(PLAYER_LINE_PATTERN)}`);
  const tracker = new PlayerTracker();
  r.stdout.split('\n').filter(Boolean).forEach((line) => tracker.feed(line));
  return tracker.list();
}

app.get('/api/players', async (req, res) => {
  try {
    res.json({ players: await getOnlinePlayers(), heuristic: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live version: tails the log continuously (seeded from recent history),
// parses join/leave lines the moment they're written, and pushes the roster
// to the client whenever it changes (plus once right after seeding, so the
// page gets an immediate answer even when nobody is online).
app.get('/api/players/live', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.on('error', () => {});
  const send = () => {
    try {
      res.write(`data: ${JSON.stringify({ players: tracker.list(), details: tracker.details() })}\n\n`);
    } catch (e) {}
  };
  const tracker = new PlayerTracker();
  const conn = new Client();
  let sshStream = null;
  let partial = '';
  let seeded = false;
  let seedTimer = null;
  // Keep proxies/browsers from timing out an idle stream.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {}
  }, 25000);

  conn
    .on('ready', () => {
      // grep --line-buffered so each matching line is forwarded immediately
      // instead of waiting for a 4 KB pipe buffer to fill.
      const cmd = `tail -n 20000 -F ${shq(config.paths.logFile)} 2>/dev/null | grep --line-buffered -E ${shq(PLAYER_LINE_PATTERN)}`;
      conn.exec(followCmd(cmd), (err, stream) => {
        if (err) {
          res.write(`event: error\ndata: ${err.message}\n\n`);
          conn.end();
          res.end();
          return;
        }
        sshStream = stream;
        const onData = (data) => {
          const text = partial + data.toString();
          const lines = text.split('\n');
          partial = lines.pop(); // keep an incomplete trailing line for the next chunk
          let changed = false;
          lines.forEach((line) => {
            if (tracker.feed(line)) changed = true;
          });
          if (!seeded) {
            // The seed history arrives as a burst; send one snapshot once it settles.
            clearTimeout(seedTimer);
            seedTimer = setTimeout(() => {
              seeded = true;
              tracker.live = true;
              send();
            }, 400);
          } else if (changed) send();
        };
        stream.on('data', onData);
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          conn.end();
          res.end();
        });
        // Empty/missing log: still answer once.
        seedTimer = setTimeout(() => {
          if (!seeded) {
            seeded = true;
            tracker.live = true;
            send();
          }
        }, 1500);
      });
    })
    .on('error', (err) => {
      res.write(`event: error\ndata: ${err.message}\n\n`);
      res.end();
    })
    .connect(sshConnectOpts());

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(seedTimer);
    try {
      if (sshStream) sshStream.close();
    } catch (e) {}
    try {
      conn.end();
    } catch (e) {}
  });
});

Object.assign(module.exports, { getOnlinePlayers });
