// Setup tab: bootstrap a fresh VPS (LinuxGSM, server, BepInEx, ValheimEnforcer, helper scripts).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config, ROOT, derivedPaths, readRegistry, curId } = require('./context');
const { safeWrite, maybeSudo, shq, sshExec, sshExecStream } = require('./exec');
const { app } = require('./app');
const firewall = require('./firewall');
const worldInfo = require('./world-info');
const settings = require('./settings');
const modifiers = require('./modifiers');
const modData = require('./mod-data');
const modCatalog = require('./mod-catalog');

// ---- Setup (bootstrap a fresh VPS: dedicated server -> BepInEx -> ValheimEnforcer) ----
//
// Every other part of the GUI assumes BepInEx + ValheimEnforcer already
// exist on the VPS — that's true for an established server, but not for someone
// starting from a brand-new headless VPS. This section is deliberately
// separate and additive: it never runs automatically, every step is its own
// button with its own confirmation, and the one genuinely risky step
// (wiring the doorstop env vars that make LGSM launch through BepInEx into
// common.cfg) is split into a preview call and a separate apply call so
// nothing gets changed without the human seeing exactly what's about to be
// added first. New config.json fields this section needs:
// paths.valheimServerDir (the dedicated server's install root — where
// valheim_server.x86_64 lives) and paths.commonCfgPath (LGSM's
// config-lgsm/vhserver/common.cfg) — both optional; every endpoint here
// degrades to a clear "not configured" response rather than crashing if
// they're unset.
//
// Rebuilt 2026-09-29: there's no systemd unit anymore (LGSM manages the
// process directly), so the old "rewrite the ExecStart= line" step doesn't
// apply. The equivalent risky step now is making sure common.cfg actually
// exports the four DOORSTOP_*/LD_* variables that route LGSM's launch
// through BepInEx's doorstop injector instead of running Valheim bare.

// Finds a package by its exact owner+name across both sources and returns
// its latest published version — used to resolve BepInExPack_Valheim and
// ValheimEnforcer's current version without hardcoding one that inevitably
// goes stale. Thunderstore is checked first since both packages have
// historically been published there.
async function findLatestPackage(owner, pkgName) {
  const ownerNorm = modData.normalize(owner);
  const nameNorm = modData.normalize(pkgName);
  for (const source of ['thunderstore', 'hexium']) {
    let pkgs;
    try {
      pkgs = await modCatalog.getPackages(source);
    } catch (e) {
      continue;
    }
    const match = pkgs.find((p) => !p.is_deprecated && modData.normalize(p.owner) === ownerNorm && modData.normalize(p.name) === nameNorm);
    if (match) {
      const latest = match.versions[0]?.version_number;
      if (latest) return { source, owner: match.owner, name: match.name, version: latest };
    }
  }
  return null;
}

// ---- Setup helpers ----

// Streams lines to the browser the same way sshExecStream does (SSE: `data:` lines,
// then a `done` event carrying the exit code) for steps that are made of several
// separate remote calls.
function startSse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.on('error', (e) => console.error('[startSse] response stream error (ignored):', e.message));
  return {
    send: (line) => safeWrite(res, `data: ${String(line).replace(/[\r\n]+/g, ' ')}\n\n`),
    done: (code) => {
      safeWrite(res, `event: done\ndata: ${code}\n\n`);
      res.end();
    },
  };
}

// Runs a whole bash script as root (directly when the connection is root, through sudo
// otherwise). Base64 keeps the script free of any quoting problems.
function asRootScript(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return maybeSudo(`bash -c "$(printf '%s' ${shq(b64)} | base64 -d)"`);
}

// The config values that get written into scripts on the VPS must be boring paths/names.
const SAFE_SETUP_VALUE = /^[A-Za-z0-9_./ +@:-]+$/;
function setupValues() {
  const p = config.paths;
  return {
    LGSM_USER: config.lgsmUser,
    LGSM_SERVER: config.lgsmServer,
    LGSM_HOME: config.lgsmHome,
    LGSM_SCRIPT: p.lgsmScript,
    SERVER_DIR: p.valheimServerDir,
    DATA_ROOT: p.worldDir,
    BACKUP_DIR: p.backupDir,
    COMMON_CFG: p.commonCfgPath,
  };
}

// Reads a script template from vps-scripts/ and fills in its __NAME__ values.
function renderScriptTemplate(name) {
  const vals = setupValues();
  for (const [k, v] of Object.entries(vals)) {
    if (!v || !SAFE_SETUP_VALUE.test(v)) throw new Error(`The config value for ${k} ("${v}") is empty or has characters the Setup steps do not allow (use letters, digits and . _ / - only).`);
  }
  const text = fs.readFileSync(path.join(ROOT, 'vps-scripts', name), 'utf8').replace(/__([A-Z][A-Z_]*)__/g, (m, k) => (k in vals ? vals[k] : m));
  const left = text.match(/__[A-Z][A-Z_]*__/);
  if (left) throw new Error(`${name}: value ${left[0]} was not filled in`);
  return text;
}

// Writes a file as root in chunks (a single command line cannot carry a very large
// file), then moves it into place atomically.
async function writeRootFileChunked(filePath, content, mode) {
  const buf = Buffer.from(content, 'utf8');
  const CHUNK = 12 * 1024; // multiple of 3 so each chunk decodes on its own; keeps every ssh exec command well under the 32 KiB packet limit
  const tmp = `${filePath}.new.${process.pid}`;
  for (let off = 0, first = true; off < buf.length || first; off += CHUNK, first = false) {
    const b64 = buf.subarray(off, off + CHUNK).toString('base64');
    const r = await sshExec(`printf '%s' ${shq(b64)} | base64 -d | ${maybeSudo(`tee ${first ? '' : '-a '}${shq(tmp)}`)} >/dev/null && echo CHUNK_OK`);
    if (!r.stdout.includes('CHUNK_OK')) throw new Error(`could not write ${filePath}: ${r.stderr || r.stdout}`.trim());
  }
  const fin = await sshExec([maybeSudo(`chmod ${mode} ${shq(tmp)}`), maybeSudo(`chown root:root ${shq(tmp)}`), maybeSudo(`mv -f ${shq(tmp)} ${shq(filePath)}`), 'echo WROTE'].join(' && '));
  if (!fin.stdout.includes('WROTE')) throw new Error(`could not finish writing ${filePath}: ${fin.stderr || fin.stdout}`.trim());
}

// The helper scripts the GUI's other tabs call. Key = config.paths key.
const HELPER_SCRIPTS = [
  { key: 'backupScript', file: 'backup-valheim.sh', mode: '755', check: 'bash' },
  { key: 'checkUpdateScript', file: 'check-valheim-update.sh', mode: '755', check: 'bash' },
  { key: 'applyUpdateScript', file: 'update-valheim.sh', mode: '755', check: 'bash' },
  { key: 'moveModScript', file: 'move-mod.py', mode: '644', check: 'py', verbatim: true },
  { key: 'generateCodesScript', file: 'generate-codes.py', mode: '644', check: 'py', verbatim: true },
];

// Read-only diagnostic covering every stage of the bootstrap. Safe to call
// as often as the Setup tab wants (e.g. after each step) to refresh its
// checklist — nothing here changes any state.
app.get('/api/setup/status', async (req, res) => {
  try {
    const p = config.paths;
    const sd = p.valheimServerDir;
    const yn = (name, test) => `if ${test}; then echo "${name}:yes"; else echo "${name}:no"; fi`;
    const checks = [
      yn('LGSM_USER', `id -u ${shq(config.lgsmUser)} >/dev/null 2>&1`),
      yn('LGSM_INSTALLED', `test -x ${shq(p.lgsmScript)}`),
      yn('DEDICATED_SERVER', `test -f ${shq(sd)}/valheim_server.x86_64`),
      yn('COMMON_CFG', `test -f ${shq(p.commonCfgPath)}`),
      yn('BEPINEX_CORE', `test -f ${shq(sd)}/BepInEx/core/BepInEx.dll`),
      yn('BEPINEX_LAUNCHER', `test -f ${shq(sd)}/start_server_bepinex.sh`),
      // Same "is it actually wired" question as before, aimed at common.cfg's
      // doorstop export lines; the preview call does the careful line-by-line
      // check before actually changing anything.
      yn('DOORSTOP_WIRED', `grep -q "DOORSTOP_ENABLED=1" ${shq(p.commonCfgPath)} 2>/dev/null`),
      yn('ENFORCER_PLUGIN', `ls -1 ${shq(p.pluginsDir)} 2>/dev/null | grep -qi valheimenforcer`),
      yn('JOTUNN_PLUGIN', `ls -1 ${shq(p.pluginsDir)} 2>/dev/null | grep -qi jotunn`),
      yn('ENFORCER_CONFIG', `test -f ${shq(p.enforcerYaml)}`),
      `echo "ENFORCER_FOUND:$(find ${shq(sd)}/BepInEx -maxdepth 4 -name Mods.yaml -ipath '*enforcer*' 2>/dev/null | head -n1)"`,
      yn('BEPINEX_LOADED', `grep -qE "Chainloader (started|startup complete)" ${shq(p.logFile)} 2>/dev/null`),
      yn('ENFORCER_LOADED', `grep -qiE "Loading \\[[^]]*ValheimEnforcer" ${shq(p.logFile)} 2>/dev/null`),
      yn('RUAMEL', `python3 -c 'import ruamel.yaml' 2>/dev/null`),
      yn('CRON', `command -v cron >/dev/null 2>&1 || command -v crond >/dev/null 2>&1`),
      ...HELPER_SCRIPTS.map((h) => yn(`HELPER_${h.key}`, `test -f ${shq(p[h.key])}`)),
      // Running server older than the newest change to common.cfg / the plugins folder?
      // Then it is still running without that change and needs a stop + start.
      `PID=$(pgrep -u ${shq(config.lgsmUser)} -f '^\\./valheim_server\\.x86_64' -o 2>/dev/null)`,
      `if [ -n "$PID" ]; then echo "SERVER_STATE:active"; ` +
        `SE=$(date -d "$(ps -o lstart= -p "$PID" 2>/dev/null)" +%s 2>/dev/null); ` +
        `if [ -n "$SE" ] && [ -n "$(find ${shq(p.commonCfgPath)} ${shq(p.pluginsDir)} -newermt "@$SE" -print -quit 2>/dev/null)" ]; then echo "NEEDS_RESTART:yes"; else echo "NEEDS_RESTART:no"; fi; ` +
        `else echo "SERVER_STATE:inactive"; echo "NEEDS_RESTART:no"; fi`,
    ];
    // Read as root: a game account's home folder is mode 750 on current Ubuntu/Debian, so a sudo user could not even see inside it.
    const r = await sshExec(asRootScript(checks.join('\n')));
    const st = {};
    r.stdout.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) st[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    // ValheimEnforcer's folder is a guess until the plugin has run once; if the real
    // Mods.yaml is somewhere else, follow it (only when the path was not set by hand).
    if (st.ENFORCER_FOUND && st.ENFORCER_FOUND !== p.enforcerYaml && derivedPaths.has('enforcerYaml')) {
      p.enforcerYaml = st.ENFORCER_FOUND;
      st.ENFORCER_CONFIG = 'yes';
    }

    // The server identity (name / world / password) lives in LinuxGSM's cfg files.
    let identity = null;
    if (st.COMMON_CFG === 'yes') {
      const w = await worldInfo.getWorldInfo();
      const pw = (await modifiers.readEffectiveCfgValue('serverpassword').catch(() => null)) || '';
      identity = {
        serverName: w.serverName,
        worldName: w.world,
        worldCreated: w.ready,
        passwordSet: pw.length >= 5,
        passwordWeak: settings.WEAK_PASSWORDS.has(pw.toLowerCase()),
        port: w.port,
        portSet: w.portExplicit,
        plannedPort: (readRegistry().find((i) => i.id === curId()) || {}).plannedPort || null,
      };
    }

    const helpers = {};
    for (const h of HELPER_SCRIPTS) helpers[h.key] = st[`HELPER_${h.key}`] === 'yes';
    res.json({
      instance: config.instance,
      plannedPort: (readRegistry().find((i) => i.id === curId()) || {}).plannedPort || null,
      lgsmUser: st.LGSM_USER === 'yes',
      lgsmInstalled: st.LGSM_INSTALLED === 'yes',
      dedicatedServer: st.DEDICATED_SERVER === 'yes',
      commonCfg: st.COMMON_CFG === 'yes',
      identity,
      bepinexCore: st.BEPINEX_CORE === 'yes',
      bepinexLauncher: st.BEPINEX_LAUNCHER === 'yes',
      doorstopWired: st.DOORSTOP_WIRED === 'yes',
      enforcerPlugin: st.ENFORCER_PLUGIN === 'yes',
      jotunnPlugin: st.JOTUNN_PLUGIN === 'yes',
      enforcerConfig: st.ENFORCER_CONFIG === 'yes',
      enforcerPath: p.enforcerYaml,
      helpers,
      ruamel: st.RUAMEL === 'yes',
      cron: st.CRON === 'yes',
      serverState: st.SERVER_STATE || 'unknown',
      needsRestart: st.NEEDS_RESTART === 'yes',
      bepinexLoaded: st.BEPINEX_LOADED === 'yes',
      enforcerLoaded: st.ENFORCER_LOADED === 'yes',
      firewall: await (async () => {
        try {
          const port = await firewall.worldGamePort();
          return port && st.LGSM_USER === 'yes' ? { port, ...(await firewall.fwRun('status', port)) } : null;
        } catch (e) {
          return null;
        }
      })(),
      paths: { serverDir: sd, scriptsDir: p.scriptsDir, commonCfg: p.commonCfgPath },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 1: game account + LinuxGSM + its dependencies (vps-scripts/setup-prepare.sh, as root).
app.get('/api/setup/prepare', (req, res) => {
  let script;
  try {
    script = renderScriptTemplate('setup-prepare.sh');
  } catch (e) {
    const sse = startSse(res);
    sse.send(`[error] ${e.message}`);
    return sse.done(1);
  }
  sshExecStream(asRootScript(script), res, { idleMs: 900000 });
});

// Step 2: LinuxGSM downloads and installs the Valheim dedicated server
// (vps-scripts/setup-install-server.sh). The path name stays install-server.
app.get('/api/setup/install-server', (req, res) => {
  let script;
  try {
    script = renderScriptTemplate('setup-install-server.sh');
  } catch (e) {
    const sse = startSse(res);
    sse.send(`[error] ${e.message}`);
    return sse.done(1);
  }
  sshExecStream(asRootScript(script), res, { idleMs: 900000 });
});

// Step 5: the helper scripts every other tab relies on (backups, update check and
// apply, mod categorizing, profile codes), plus the folders they use. An existing
// script that differs is kept as <name>.bak.<time> before being replaced.
app.get('/api/setup/install-helpers', async (req, res) => {
  const sse = startSse(res);
  try {
    const p = config.paths;
    const user = config.lgsmUser;
    const vals = setupValues(); // validates every path used below
    for (const k of ['scriptsDir', 'disabledModsDir']) {
      if (!SAFE_SETUP_VALUE.test(p[k] || '')) throw new Error(`paths.${k} has unsupported characters`);
    }
    sse.send('[step] Creating folders...');
    const mk = await sshExec(
      [
        maybeSudo(`install -d -m 755 ${shq(p.scriptsDir)}`),
        maybeSudo(`install -d -o ${shq(user)} -g ${shq(user)} ${shq(p.backupDir)} ${shq(p.disabledModsDir)} ${shq(`${vals.LGSM_HOME}/.config`)}`),
        'echo MADE',
      ].join(' && ')
    );
    if (!mk.stdout.includes('MADE')) throw new Error(`could not create folders: ${mk.stderr || mk.stdout}`.trim());

    sse.send('[step] Checking the Python YAML library the Mods tab needs (ruamel.yaml)...');
    const py = await sshExec(
      `python3 -c 'import ruamel.yaml' 2>/dev/null && echo HAVE || { ${maybeSudo('apt-get install -y -qq python3-ruamel.yaml')} >/dev/null 2>&1; python3 -c 'import ruamel.yaml' 2>/dev/null && echo INSTALLED || { ${maybeSudo('pip3 install --quiet --break-system-packages ruamel.yaml')} >/dev/null 2>&1; python3 -c 'import ruamel.yaml' 2>/dev/null && echo INSTALLED || echo MISSING; }; }`
    );
    if (py.stdout.includes('MISSING')) throw new Error('could not install ruamel.yaml — run "apt install python3-ruamel.yaml" on the VPS and retry');
    sse.send(py.stdout.includes('HAVE') ? '[note] ruamel.yaml already installed' : '[note] ruamel.yaml installed');

    for (const h of HELPER_SCRIPTS) {
      const dest = p[h.key];
      if (!SAFE_SETUP_VALUE.test(dest)) throw new Error(`paths.${h.key} has unsupported characters`);
      const content = h.verbatim ? fs.readFileSync(path.join(ROOT, 'vps-scripts', h.file), 'utf8') : renderScriptTemplate(h.file);
      sse.send(`[step] Installing ${h.file} -> ${dest}`);
      const sum = crypto.createHash('sha256').update(content).digest('hex');
      const cur = await sshExec(`sha256sum ${shq(dest)} 2>/dev/null | cut -d' ' -f1`);
      if (cur.stdout.trim() === sum) {
        sse.send('[note] already up to date');
        continue;
      }
      if (cur.stdout.trim()) {
        const bak = `${dest}.bak.${Date.now()}`;
        await sshExec(maybeSudo(`cp -p ${shq(dest)} ${shq(bak)}`));
        sse.send(`[note] the existing file differed — kept as ${bak}`);
      }
      await writeRootFileChunked(dest, content, h.mode);
      const syn = h.check === 'bash' ? `bash -n ${shq(dest)}` : `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' ${shq(dest)}`;
      const chk = await sshExec(`${syn} && echo SYNTAX_OK`);
      if (!chk.stdout.includes('SYNTAX_OK')) throw new Error(`${h.file} was written but failed its syntax check: ${chk.stderr || chk.stdout}`.trim());
    }
    sse.send('[done] Helper scripts installed. Backups, the update check and the Mods tab can now run.');
    sse.done(0);
  } catch (e) {
    sse.send(`[error] ${e.message}`);
    sse.done(1);
  }
});

// Downloads BepInExPack_Valheim's current version and merges its contents
// (the BepInEx/ folder, winhttp.dll, doorstop_config.ini, and the
// start_server_bepinex.sh/start_game_bepinex.sh launcher scripts) directly
// into paths.valheimServerDir, exactly as denikson's own install
// instructions describe for a dedicated server — this does NOT touch the
// systemd unit; that's the separate preview/apply step below, on purpose.
app.get('/api/setup/install-bepinex', async (req, res) => {
  if (!config.paths.valheimServerDir) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] paths.valheimServerDir is not set in config.json.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  let pkg;
  try {
    pkg = await findLatestPackage('denikson', 'BepInExPack_Valheim');
  } catch (e) {
    pkg = null;
  }
  if (!pkg) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: [error] could not find denikson-BepInExPack_Valheim on Thunderstore or Hexium right now.\n\n');
    res.write('event: done\ndata: 1\n\n');
    return res.end();
  }
  const dir = config.paths.valheimServerDir;
  const downloadUrl = modCatalog.buildDownloadUrl(pkg.source, pkg.owner, pkg.name, pkg.version);
  const tmp = `/tmp/bepinex_setup_$$`;
  const cmd = [
    `echo "[step] installing BepInExPack_Valheim v${pkg.version} from ${pkg.source} into ${dir}..."`,
    `\\rm -rf ${shq(tmp)}`,
    `mkdir -p ${shq(tmp)}`,
    `curl -sL --connect-timeout 15 --max-time 180 ${shq(downloadUrl)} -o ${shq(tmp)}/pack.zip`,
    `if [ ! -s ${shq(tmp)}/pack.zip ]; then echo "[error] downloaded file is empty — check the download URL is still valid: ${downloadUrl}"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `if ! head -c 2 ${shq(tmp)}/pack.zip | grep -q PK; then echo "[error] downloaded file is not a valid zip"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    `cd ${shq(tmp)} && unzip -oq pack.zip -d extracted; UNZIP_EC=$?; cd - >/dev/null; ` +
      `if [ "$UNZIP_EC" -gt 1 ]; then echo "[error] unzip exited with code $UNZIP_EC"; \\rm -rf ${shq(tmp)}; exit 1; fi`,
    // The package zip has manifest.json / icon.png / README.md at its top level and the
    // files that belong in the game folder inside a "BepInExPack_Valheim/" wrapper folder
    // (the same thing mod managers special-case). Merge that folder's CONTENTS: find the
    // folder holding start_server_bepinex.sh. Only if the pack has no such file, fall back to
    // "a single wrapper folder and nothing else".
    `SRC=${shq(tmp)}/extracted; ` +
      `MARK="$(find "$SRC" -maxdepth 3 -type f -name start_server_bepinex.sh | head -n 1)"; ` +
      `if [ -n "$MARK" ]; then SRC="$(dirname "$MARK")"; ` +
      `elif [ "$(find "$SRC" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$SRC" -mindepth 1 -maxdepth 1)" ]; then SRC="$(find "$SRC" -mindepth 1 -maxdepth 1)"; fi; ` +
      `chmod -R u+rwX,go+rX "$SRC"; ` +
      `\\cp -rf "$SRC"/. ${shq(dir)}/`,
    `chmod u+x ${shq(dir)}/start_server_bepinex.sh 2>/dev/null; chmod u+x ${shq(dir)}/start_game_bepinex.sh 2>/dev/null; true`,
    `\\rm -rf ${shq(tmp)}`,
    `if [ ! -f ${shq(dir)}/start_server_bepinex.sh ]; then echo "[error] extraction finished but start_server_bepinex.sh is missing from ${dir} — the pack's layout may have changed, check manually"; exit 1; fi`,
    // Same reasoning as install-server above: this ran as root over SSH,
    // so the BepInEx files just merged in are root-owned. LGSM's ownership
    // check would otherwise block every future start.
    `chown -R ${shq(config.lgsmUser || 'vhserver')}:${shq(config.lgsmUser || 'vhserver')} ${shq(dir)}`,
    `echo "[done] BepInEx files placed in ${dir}. Next: use the preview/apply buttons below to wire common.cfg's doorstop env vars, then Stop and Start the server from the Dashboard."`,
  ].join(' && ');
  sshExecStream(asRootScript(cmd), res, { idleMs: 600000 });
});

// Computes (but does not apply) the common.cfg addition needed to launch
// through BepInEx under LGSM: LGSM has no ExecStart= line to swap — the
// dedicated server binary is always launched the same way — so what's
// actually needed is the four `export DOORSTOP_*`/`export LD_*` lines that
// route that launch through BepInEx's doorstop injector instead of running
// Valheim bare. Read-only. Idempotent via BEPINEX_MARKER: re-running when
// already wired reports alreadyWired instead of proposing a duplicate block.
const BEPINEX_MARKER = '# --- BepInEx doorstop (added by valheim-gui) ---';

async function computeDoorstopChange() {
  const cfgPath = config.paths.commonCfgPath;
  const dir = config.paths.valheimServerDir;
  if (!cfgPath || !dir) return { error: 'paths.commonCfgPath and paths.valheimServerDir must both be set in config.json' };

  const r = await sshExec(`cat ${shq(cfgPath)} 2>/dev/null`);
  const current = r.stdout;
  if (!current) return { error: `couldn't read ${cfgPath} — check paths.commonCfgPath is correct and the file exists on the VPS` };

  const alreadyWired = current.includes(BEPINEX_MARKER) && current.includes('DOORSTOP_ENABLED=1');
  const proposedBlock = [
    BEPINEX_MARKER,
    'export DOORSTOP_ENABLED=1',
    `export DOORSTOP_TARGET_ASSEMBLY="${dir}/BepInEx/core/BepInEx.Preloader.dll"`,
    `export LD_LIBRARY_PATH="${dir}/doorstop_libs:\${LD_LIBRARY_PATH}"`,
    // Absolute path, not a bare filename — this project already hit a real
    // bug where a bare "libdoorstop_x64.so" depended on LD_LIBRARY_PATH
    // ordering/timing during LGSM's own startup and silently failed to
    // preload. The absolute path removes that dependency entirely.
    `export LD_PRELOAD="${dir}/doorstop_libs/libdoorstop_x64.so"`,
  ].join('\n');

  return {
    currentContent: current,
    proposedBlock,
    alreadyWired,
    cfgPath,
  };
}

app.get('/api/setup/systemd-preview', async (req, res) => {
  try {
    const result = await computeDoorstopChange();
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Applies the block computed above. Re-computes it server-side rather than
// trusting anything from the request body, so this can only ever apply the
// exact same block the preview call just showed the human — nothing else is
// editable through this endpoint. Backs up common.cfg first; does NOT
// restart the service (use the Dashboard's Stop, then Start once this is
// applied, so the live process only bounces on an explicit, separate
// action — env var changes in common.cfg only take effect on next start).
app.post('/api/setup/systemd-apply', async (req, res) => {
  try {
    const result = await computeDoorstopChange();
    if (result.error) return res.status(400).json({ error: result.error });
    if (result.alreadyWired) return res.json({ ...result, applied: false, note: 'already wired to BepInEx — nothing to change' });

    const cfgPath = config.paths.commonCfgPath;
    const backupPath = `${cfgPath}.bak.${Date.now()}`;
    // Base64-encode the block before interpolating it into the remote
    // command — same reasoning as the old systemd version had: no shell
    // metacharacters to worry about no matter what the paths contain.
    const blockB64 = Buffer.from(`\n${result.proposedBlock}\n`, 'utf8').toString('base64');
    const cmd = [
      // -p keeps the file's owner: LinuxGSM refuses to start the server when anything under its
      // lgsm/ folder (which holds common.cfg) is not owned by the game account.
      maybeSudo(`cp -p ${shq(cfgPath)} ${shq(backupPath)}`),
      // Appended, not substituted — common.cfg has no existing doorstop
      // lines to replace on a fresh install, unlike the old single
      // ExecStart= line. Written through sudo so only the actual write
      // needs elevation, same convention as the old apply endpoint.
      `printf '%s' ${shq(blockB64)} | base64 -d | ${maybeSudo(`tee -a ${shq(cfgPath)}`)} >/dev/null`,
      `echo APPLIED`,
    ].join(' && ');
    const r = await sshExec(cmd);
    if (!r.stdout.includes('APPLIED')) {
      return res.status(500).json({ error: `command did not complete as expected: ${r.stdout} ${r.stderr}` });
    }
    res.json({ ...result, applied: true, backupPath, note: 'Added to common.cfg. Stop and Start the server from the Dashboard to pick it up.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolves ValheimEnforcer's current version/source so the frontend can
// hand it straight to the existing, already-battle-tested /api/mods/install
// endpoint — ValheimEnforcer is, from Thunderstore/Hexium's point of view,
// just a normal BepInEx plugin, so it doesn't need its own install logic.
app.get('/api/setup/enforcer-version', async (req, res) => {
  try {
    const pkg = await findLatestPackage('MidnightMods', 'ValheimEnforcer');
    if (!pkg) return res.status(404).json({ error: 'could not find MidnightMods-ValheimEnforcer on Thunderstore or Hexium right now' });
    // Enforcer needs Jotunn (and whatever Jotunn needs). A plain install of
    // the plugin alone makes BepInEx refuse to load it ("missing dependencies:
    // com.jotunn.jotunn"), so resolve the chain here and report only what the
    // plugins folder doesn't already contain, dependencies first.
    const lsr = await sshExec(`ls -1 ${shq(config.paths.pluginsDir)} 2>/dev/null`);
    const ordered = await modCatalog.resolveDependencyPlan(pkg.source, pkg.owner, pkg.name, pkg.version, lsr.stdout.split('\n').filter(Boolean));
    res.json({ ...pkg, dependencies: ordered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================================================

Object.assign(module.exports, { asRootScript, writeRootFileChunked, findLatestPackage, SAFE_SETUP_VALUE });
