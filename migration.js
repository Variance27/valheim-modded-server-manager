'use strict';
// Moving everything to a new VPS: an export bundle built on the old VPS, downloaded through the GUI,
// uploaded to the new VPS, verified and unpacked there. This file holds the pure parts: the bundle
// format, validation of everything that comes out of a bundle, and the shell scripts that run on the
// VPS. No network or SSH in here, so it can be unit-tested (the tests run the scripts for real).
//
// Bundle layout (an uncompressed tar, so the manifest can be read without reading the whole file):
//   manifest.json                 what is inside (see buildManifest)
//   worlds/<id>/saves.tgz         the world's save folder (worlds_local, admin/ban/permitted lists)
//   worlds/<id>/lgsm.tgz          the LinuxGSM config folder (server name, password, port, launch options)
//   worlds/<id>/bepinex.tgz       BepInEx plugins, config and patchers (includes ValheimEnforcer's files)
//   worlds/<id>/extras.tgz        disabled-mods and mod-snapshots, when they exist
//   SHA256SUMS                    checksum of every part, checked before anything is unpacked

const FORMAT = 1;
// (VGUI_MIGRATION_DIR exists only so the tests can run the scripts in a temp folder.)
const STAGE_ROOT = /^\/[A-Za-z0-9_./-]+$/.test(process.env.VGUI_MIGRATION_DIR || '') ? process.env.VGUI_MIGRATION_DIR : '/var/tmp/vgui-migration';
const TOKEN_RE = /^\d{14}$/;
const WORLD_ID_RE = /^(?:main|[a-z][a-z0-9]{0,9})$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9_./+@-]+$/;
const PARTS = ['saves.tgz', 'lgsm.tgz', 'bepinex.tgz', 'extras.tgz'];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const isSafePath = (p) => typeof p === 'string' && SAFE_PATH_RE.test(p) && !p.split('/').includes('..') && !p.includes('//');
const within = (p, root) => p === root || p.startsWith(`${root.replace(/\/+$/, '')}/`);

// A world as the scripts need it. Anything that ends up inside a script is checked here.
function checkSpec(w) {
  const bad = (m) => {
    throw new Error(`world "${w && w.id}": ${m}`);
  };
  if (!w || !WORLD_ID_RE.test(w.id || '')) bad('invalid id');
  if (!USER_RE.test(w.user || '')) bad('invalid game account name');
  for (const k of ['home', 'listDir', 'serverDir', 'cfgDir']) if (!isSafePath(w[k])) bad(`unsafe or missing ${k}`);
  if (!within(w.listDir, w.home)) bad('the save folder is outside the game account home');
  if (!within(w.serverDir, w.home)) bad('the server folder is outside the game account home');
  if (!within(w.cfgDir, w.home)) bad('the LinuxGSM config folder is outside the game account home');
  return w;
}

function buildManifest({ guiVersion, createdAt, includes, worlds }) {
  return {
    format: FORMAT,
    createdAt: createdAt || new Date().toISOString(),
    guiVersion: guiVersion || null,
    includes: { saves: !!(includes && includes.saves), mods: !!(includes && includes.mods) },
    worlds: worlds.map((w) => ({
      id: w.id,
      label: String(w.label || w.id).slice(0, 30),
      lgsmUser: w.user,
      lgsmServer: w.lgsmServer || 'vhserver',
      home: w.home,
      plannedPort: Number.isInteger(w.plannedPort) ? w.plannedPort : null,
    })),
  };
}

// The manifest comes out of a file the user uploaded; accept only what a bundle from this GUI looks like.
function parseManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'This file is not a migration bundle (no readable manifest).' };
  }
  if (!m || m.format !== FORMAT) return { ok: false, error: `Unsupported bundle format (${m && m.format}). Export it again with a matching GUI version.` };
  if (!Array.isArray(m.worlds) || !m.worlds.length || m.worlds.length > 9) return { ok: false, error: 'The bundle lists no worlds.' };
  const seen = new Set();
  const worlds = [];
  for (const w of m.worlds) {
    if (!w || !WORLD_ID_RE.test(w.id || '') || seen.has(w.id)) return { ok: false, error: 'The bundle has an invalid or repeated world id.' };
    if (!USER_RE.test(w.lgsmUser || '') || !isSafePath(w.home)) return { ok: false, error: `The bundle has invalid details for world "${w.id}".` };
    seen.add(w.id);
    worlds.push({
      id: w.id,
      label: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,29}$/.test(w.label || '') ? w.label : w.id,
      lgsmUser: w.lgsmUser,
      lgsmServer: /^[a-z][a-z0-9_-]{0,31}$/.test(w.lgsmServer || '') ? w.lgsmServer : 'vhserver',
      home: w.home,
      plannedPort: Number.isInteger(w.plannedPort) && w.plannedPort >= 1024 && w.plannedPort <= 65530 ? w.plannedPort : null,
    });
  }
  return { ok: true, manifest: { format: FORMAT, createdAt: String(m.createdAt || ''), guiVersion: m.guiVersion ? String(m.guiVersion).slice(0, 20) : null, includes: { saves: !!(m.includes && m.includes.saves), mods: !!(m.includes && m.includes.mods) }, worlds } };
}

// SHA256SUMS lines: "<64 hex>  worlds/<id>/<part>"
function parseSums(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]worlds\/((?:main|[a-z][a-z0-9]{0,9}))\/(saves|lgsm|bepinex|extras)\.tgz$/.exec(line.trim());
    if (m) (out[m[2]] = out[m[2]] || {})[`${m[3]}.tgz`] = m[1];
  }
  return out;
}

// ---- scripts (bash, run as root on the VPS) ----

// Shared by every unpack: refuse archives that would write outside the target (absolute paths, "..",
// or links pointing outside).
const SAFE_LISTING = [
  'safe_listing() { # $1 = tar listing (tar -tv output) on stdin',
  "  awk '{ line=$0; sub(/^[^ ]+ +[^ ]+ +[0-9]+ +[0-9-]+ +[0-9:]+ +/, \"\", line); n=line; t=\"\"; if (match(line, / (->|link to) /)) { n=substr(line,1,RSTART-1); t=substr(line,RSTART+RLENGTH) }",
  '    if (n ~ /^\\// || n ~ /(^|\\/)\\.\\.(\\/|$)/ || t ~ /^\\// || t ~ /(^|\\/)\\.\\.(\\/|$)/) { bad=1 } } END { exit bad ? 1 : 0 }\'',
  '}',
].join('\n');

function previewScript(worlds) {
  const lines = ['set -u', `mkdir -p ${shq(STAGE_ROOT)} 2>/dev/null; echo "FREE_KB:$(df -Pk ${STAGE_ROOT} 2>/dev/null | awk 'NR==2{print $4}')"`];
  for (const w of worlds.map(checkSpec)) {
    lines.push(
      `ID=${shq(w.id)}; U=${shq(w.user)}; V=${shq(w.listDir)}; S=${shq(w.serverDir)}; C=${shq(w.cfgDir)}; H=${shq(w.home)}`,
      'ACC=0; id -u "$U" >/dev/null 2>&1 && ACC=1',
      'RUN=$(pgrep -u "$U" -f \'^\\./valheim_server\\.x86_64\' 2>/dev/null | wc -l)',
      'SV=0; [ -d "$V" ] && SV=$(du -sk "$V" 2>/dev/null | cut -f1)',
      'BP=0; for i in plugins config patchers; do [ -d "$S/BepInEx/$i" ] && BP=$((BP + $(du -sk "$S/BepInEx/$i" 2>/dev/null | cut -f1))); done',
      'EX=0; for i in disabled-mods mod-snapshots; do [ -d "$H/$i" ] && EX=$((EX + $(du -sk "$H/$i" 2>/dev/null | cut -f1))); done',
      'CF=0; [ -d "$C" ] && CF=1',
      'BEP=0; [ -d "$S/BepInEx/core" ] && BEP=1',
      'WN=$(ls -1 "$V/worlds_local" "$V/worlds" 2>/dev/null | grep -E "\\.(db|fwl)$" | sed -E "s/\\.(db|fwl)$//" | sort -u | paste -sd, -)',
      'echo "W|$ID|$ACC|$RUN|$SV|$BP|$EX|$CF|$BEP|$WN"'
    );
  }
  return lines.join('\n');
}

// manifestJson: the manifest text, written into the bundle first.
function exportScript({ token, worlds, saves, mods, allowRunning, manifestJson }) {
  if (!TOKEN_RE.test(token)) throw new Error('bad token');
  const specs = worlds.map(checkSpec);
  const stage = `${STAGE_ROOT}/export-${token}`;
  const L = [
    'set -u',
    `ROOT=${shq(STAGE_ROOT)}; STAGE=${shq(stage)}; ALLOW=${allowRunning ? 1 : 0}`,
    'mkdir -p "$ROOT" && chmod 700 "$ROOT" || { echo "[error] cannot create $ROOT"; exit 2; }',
    // Earlier exports are removed first, so unfinished ones never pile up.
    'for old in "$ROOT"/export-*; do [ -d "$old" ] && rm -rf "$old"; done',
    'mkdir -p "$STAGE/worlds" && chmod 700 "$STAGE" || { echo "[error] cannot create $STAGE"; exit 2; }',
    `printf '%s' ${shq(Buffer.from(manifestJson, 'utf8').toString('base64'))} | base64 -d > "$STAGE/manifest.json"`,
    // A world that is running is changing under us: refuse unless the caller said it is fine.
    'RUNNING=""',
  ];
  for (const w of specs) L.push(`pgrep -u ${shq(w.user)} -f '^\\./valheim_server\\.x86_64' >/dev/null 2>&1 && RUNNING="$RUNNING ${w.id}"`);
  L.push('if [ -n "$RUNNING" ] && [ "$ALLOW" != 1 ]; then echo "[running]$RUNNING"; rm -rf "$STAGE"; exit 4; fi');
  // Room check: the compressed parts are never bigger than the sources, so the sources are an upper bound.
  L.push('NEED=0');
  for (const w of specs) {
    if (saves) L.push(`[ -d ${shq(w.listDir)} ] && NEED=$((NEED + $(du -sk ${shq(w.listDir)} | cut -f1)))`, `[ -d ${shq(w.cfgDir)} ] && NEED=$((NEED + $(du -sk ${shq(w.cfgDir)} | cut -f1)))`);
    if (mods) L.push(`for i in plugins config patchers; do [ -d ${shq(`${w.serverDir}/BepInEx`)}/$i ] && NEED=$((NEED + $(du -sk ${shq(`${w.serverDir}/BepInEx`)}/$i | cut -f1))); done`);
  }
  L.push(
    'FREE=$(df -Pk "$ROOT" | awk \'NR==2{print $4}\')',
    'if [ "${FREE:-0}" -lt "$NEED" ]; then echo "[error] not enough free space in $ROOT: need up to $((NEED/1024)) MB, have $((FREE/1024)) MB. Free some space, or export fewer parts."; rm -rf "$STAGE"; exit 5; fi',
    'tarok() { rc=$1; [ "$rc" -le 1 ]; } # 1 = a file changed while being read (a live server), still usable',
    'FAIL=0'
  );
  for (const w of specs) {
    const D = `"$STAGE/worlds/${w.id}"`;
    L.push(`echo "--- ${w.id} ---"`, `mkdir -p ${D}`);
    if (saves) {
      L.push(
        `if [ -d ${shq(w.listDir)} ]; then echo "packing saves..."; tar -czf ${D}/saves.tgz -C ${shq(w.listDir)} .; tarok $? || { echo "[error] could not pack the saves of ${w.id}"; FAIL=1; }; else echo "(no save folder yet)"; fi`,
        `if [ -d ${shq(w.cfgDir)} ]; then echo "packing LinuxGSM config..."; tar -czf ${D}/lgsm.tgz -C ${shq(w.cfgDir)} .; tarok $? || { echo "[error] could not pack the LinuxGSM config of ${w.id}"; FAIL=1; }; fi`
      );
    }
    if (mods) {
      const bep = `${w.serverDir}/BepInEx`;
      L.push(
        `ITEMS=""; for i in plugins config patchers; do [ -d ${shq(bep)}/$i ] && ITEMS="$ITEMS $i"; done`,
        `if [ -n "$ITEMS" ]; then echo "packing mods and configs..."; tar -czf ${D}/bepinex.tgz -C ${shq(bep)} $ITEMS; tarok $? || { echo "[error] could not pack the mods of ${w.id}"; FAIL=1; }; else echo "(no BepInEx folders)"; fi`,
        `EX=""; for i in disabled-mods mod-snapshots; do [ -d ${shq(w.home)}/$i ] && EX="$EX $i"; done`,
        `if [ -n "$EX" ]; then tar -czf ${D}/extras.tgz -C ${shq(w.home)} $EX; tarok $? || { echo "[error] could not pack extras of ${w.id}"; FAIL=1; }; fi`
      );
    }
  }
  L.push(
    '[ "$FAIL" = 0 ] || { rm -rf "$STAGE"; exit 6; }',
    'echo "checksums..."',
    '(cd "$STAGE" && find worlds -type f -name "*.tgz" | sort | xargs -r sha256sum > SHA256SUMS)',
    'BYTES=$(du -sb "$STAGE" | cut -f1)',
    'echo "EXPORT_READY ' + token + ' $BYTES"'
  );
  return L.join('\n');
}

// Streams the finished bundle as a tar (manifest first, checksums last).
const downloadCommand = (token) => `tar -cf - -C ${shq(`${STAGE_ROOT}/export-${token}`)} manifest.json worlds SHA256SUMS`;

// Reads the manifest and the checksum list out of an uploaded bundle without unpacking it.
function readBundleCommand(token, member) {
  if (!TOKEN_RE.test(token) || !['manifest.json', 'SHA256SUMS'].includes(member)) throw new Error('bad request');
  return `tar -xOf ${shq(`${STAGE_ROOT}/import-${token}/bundle.tar`)} --occurrence=1 ${member} 2>/dev/null`;
}

// Prints OK/BAD per part, comparing what is in the tar against SHA256SUMS.
function verifyScript(token) {
  if (!TOKEN_RE.test(token)) throw new Error('bad token');
  const B = `${STAGE_ROOT}/import-${token}/bundle.tar`;
  return [
    'set -u',
    `B=${shq(B)}`,
    '[ -f "$B" ] || { echo "[error] the uploaded bundle is gone"; exit 2; }',
    'SUMS=$(tar -xOf "$B" --occurrence=1 SHA256SUMS 2>/dev/null) || SUMS=""',
    '[ -n "$SUMS" ] || { echo "[error] the bundle has no checksum list, so it is incomplete or not a bundle"; exit 3; }',
    'BADN=0',
    'while read -r sum name; do',
    '  name="${name#\\*}"',
    '  case "$name" in worlds/*.tgz) ;; *) continue ;; esac',
    '  got=$(tar -xOf "$B" --occurrence=1 "$name" 2>/dev/null | sha256sum | cut -d" " -f1)',
    '  if [ "$got" = "$sum" ]; then echo "OK $name"; else echo "BAD $name"; BADN=$((BADN+1)); fi',
    'done <<EOF',
    '$SUMS',
    'EOF',
    '[ "$BADN" = 0 ] && echo "VERIFIED" || { echo "[error] $BADN part(s) do not match their checksum: the upload was cut short or the file changed"; exit 4; }',
  ].join('\n');
}

// Lists which parts a bundle holds, one "worlds/<id>/<part>" per line.
const listPartsCommand = (token) => `tar -tf ${shq(`${STAGE_ROOT}/import-${token}/bundle.tar`)} 2>/dev/null | grep -E '^worlds/[a-z0-9]+/[a-z]+\\.tgz$'`;

// w: checkSpec'd target world; oldHome: the world's home on the old VPS (from the manifest).
function importScript({ token, w, parts, oldHome, overwrite, doSaves, doMods, ts }) {
  checkSpec(w);
  if (!TOKEN_RE.test(token) || !/^\d{14}$/.test(ts)) throw new Error('bad token');
  if (!isSafePath(oldHome)) throw new Error('bad old home');
  const has = (p) => parts.includes(p);
  const B = `${STAGE_ROOT}/import-${token}/bundle.tar`;
  const member = (p) => `worlds/${w.id}/${p}`;
  const L = [
    'set -u',
    `B=${shq(B)}; U=${shq(w.user)}; HOME_DIR=${shq(w.home)}; V=${shq(w.listDir)}; S=${shq(w.serverDir)}; C=${shq(w.cfgDir)}; OLD=${shq(oldHome)}; OVER=${overwrite ? 1 : 0}; TS=${shq(ts)}`,
    'KEEP="$HOME_DIR/pre-migration-$TS"',
    SAFE_LISTING,
    'id -u "$U" >/dev/null 2>&1 || { echo "[error] the game account $U does not exist on this VPS yet. Run this world\'s Setup steps first."; exit 2; }',
    'if pgrep -u "$U" -f \'^\\./valheim_server\\.x86_64\' >/dev/null 2>&1; then echo "[running] stop this world first"; exit 4; fi',
    '[ -f "$B" ] || { echo "[error] the uploaded bundle is gone"; exit 2; }',
    // Each part is checked before it is unpacked, then streamed straight out of the bundle (no second copy on disk).
    'unpack() { # $1 member, $2 target dir',
    '  tar -xOf "$B" --occurrence=1 "$1" | tar -tvzf - | safe_listing || { echo "[error] $1 contains paths outside its folder; refusing it"; return 1; }',
    '  mkdir -p "$2" && tar -xOf "$B" --occurrence=1 "$1" | tar -xzf - -C "$2" --no-same-owner || return 1',
    '}',
    'chown_up() { # give the account the folders we had to create between its home and $1',
    '  d="$1"; while [ "$d" != "$HOME_DIR" ] && [ "$d" != "/" ]; do chown "$U:" "$d" 2>/dev/null; d=$(dirname "$d"); done',
    '}',
    'FAIL=0'
  ];
  if (doSaves && has('saves.tgz')) {
    L.push(
      'echo "saves..."',
      'EXIST=$(ls -1 "$V/worlds_local" "$V/worlds" 2>/dev/null | grep -E "\\.(db|fwl)$" | head -n1)',
      'if [ -n "$EXIST" ] && [ "$OVER" != 1 ]; then echo "[collision] this world already has saves on this VPS"; exit 3; fi',
      'if [ -n "$EXIST" ]; then mkdir -p "$KEEP/saves"; for i in worlds_local worlds adminlist.txt bannedlist.txt permittedlist.txt; do [ -e "$V/$i" ] && mv "$V/$i" "$KEEP/saves/"; done; echo "kept what was there in $KEEP/saves"; fi',
      `unpack ${shq(member('saves.tgz'))} "$V" && echo "saves unpacked" || FAIL=1`,
      'chown -R "$U:" "$V"; chown_up "$V"'
    );
  } else if (doSaves) L.push('echo "(the bundle has no saves for this world)"');
  if (doSaves && has('lgsm.tgz')) {
    L.push(
      'echo "LinuxGSM config..."',
      'if [ -d "$C" ] && ls "$C"/*.cfg >/dev/null 2>&1; then mkdir -p "$KEEP/lgsm" && cp -a "$C"/. "$KEEP/lgsm/"; fi',
      `unpack ${shq(member('lgsm.tgz'))} "$C" && echo "LinuxGSM config unpacked" || FAIL=1`,
      // Paths inside the config pointed at the old home folder; point them at this one.
      'if [ "$OLD" != "$HOME_DIR" ]; then for f in "$C"/*.cfg; do [ -f "$f" ] && sed -i "s#$OLD#$HOME_DIR#g" "$f"; done; echo "paths in the config now point to $HOME_DIR"; fi',
      'chown -R "$U:" "$C"; chown_up "$C"'
    );
  }
  if (doMods && has('bepinex.tgz')) {
    L.push(
      'echo "mods and configs..."',
      '[ -d "$S/BepInEx/core" ] || { echo "[error] BepInEx is not installed in $S yet. Run this world\'s Setup step for BepInEx first, then import again."; FAIL=1; }',
      'if [ "$FAIL" = 0 ]; then',
      '  for i in plugins config patchers; do [ -e "$S/BepInEx/$i" ] && { mkdir -p "$KEEP/bepinex"; mv "$S/BepInEx/$i" "$KEEP/bepinex/"; }; done',
      `  unpack ${shq(member('bepinex.tgz'))} "$S/BepInEx" && echo "mods and configs unpacked" || FAIL=1`,
      '  chmod -R u+rwX,go+rX "$S/BepInEx/plugins" "$S/BepInEx/config" 2>/dev/null',
      '  chown -R "$U:" "$S/BepInEx"',
      'fi'
    );
    if (has('extras.tgz')) L.push(`if [ "$FAIL" = 0 ]; then unpack ${shq(member('extras.tgz'))} "$HOME_DIR" && echo "disabled mods and snapshots unpacked"; chown -R "$U:" "$HOME_DIR/disabled-mods" "$HOME_DIR/mod-snapshots" 2>/dev/null; fi`);
  } else if (doMods) L.push('echo "(the bundle has no mods for this world)"');
  L.push('[ -d "$KEEP" ] && chown -R "$U:" "$KEEP" 2>/dev/null');
  L.push(`[ "$FAIL" = 0 ] && echo "IMPORTED ${w.id}" || { echo "[error] ${w.id} was not fully imported"; exit 6; }`);
  return L.join('\n');
}

module.exports = { FORMAT, STAGE_ROOT, TOKEN_RE, WORLD_ID_RE, PARTS, isSafePath, checkSpec, buildManifest, parseManifest, parseSums, previewScript, exportScript, downloadCommand, readBundleCommand, verifyScript, listPartsCommand, importScript };
