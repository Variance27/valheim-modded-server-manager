'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const m = require('../migration');

const world = (over = {}) => ({
  id: 'main',
  user: 'vhserver',
  home: '/home/vhserver',
  listDir: '/home/vhserver/.config/unity3d/IronGate/Valheim',
  serverDir: '/home/vhserver/serverfiles',
  cfgDir: '/home/vhserver/lgsm/config-lgsm/vhserver',
  ...over,
});

test('isSafePath rejects traversal, doubled slashes and shell characters', () => {
  assert.equal(m.isSafePath('/home/vhserver/a.b_c-d'), true);
  for (const p of ['relative/path', '/home/../etc', '/home//x', '/home/x y', "/home/x'y", '/home/$(id)', '']) assert.equal(m.isSafePath(p), false, p);
});

test('checkSpec keeps every folder inside the account home', () => {
  assert.doesNotThrow(() => m.checkSpec(world()));
  assert.throws(() => m.checkSpec(world({ listDir: '/etc' })), /outside/);
  assert.throws(() => m.checkSpec(world({ serverDir: '/home/vhserver2/serverfiles' })), /outside/); // a sibling account is not "inside"
  assert.throws(() => m.checkSpec(world({ id: 'Bad' })), /invalid id/);
  assert.throws(() => m.checkSpec(world({ user: 'root;rm' })), /account/);
});

test('buildManifest and parseManifest round-trip', () => {
  const man = m.buildManifest({ guiVersion: '1.0.0', createdAt: 'now', includes: { saves: true }, worlds: [{ ...world(), label: 'Main world', plannedPort: 2456 }] });
  const r = m.parseManifest(JSON.stringify(man));
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.worlds, [{ id: 'main', label: 'Main world', lgsmUser: 'vhserver', lgsmServer: 'vhserver', home: '/home/vhserver', plannedPort: 2456 }]);
  assert.deepEqual(r.manifest.includes, { saves: true, mods: false });
});

test('parseManifest rejects anything that is not a bundle from this GUI', () => {
  assert.equal(m.parseManifest('not json').ok, false);
  assert.equal(m.parseManifest(JSON.stringify({ format: 99, worlds: [] })).ok, false);
  const w = { id: 'main', lgsmUser: 'vhserver', home: '/home/vhserver' };
  assert.equal(m.parseManifest(JSON.stringify({ format: 1, worlds: [w, w] })).ok, false, 'repeated id');
  assert.equal(m.parseManifest(JSON.stringify({ format: 1, worlds: [{ ...w, home: '/home/../root' }] })).ok, false, 'unsafe home');
  const odd = m.parseManifest(JSON.stringify({ format: 1, worlds: [{ ...w, label: '<script>', plannedPort: 80 }] }));
  assert.equal(odd.manifest.worlds[0].label, 'main');
  assert.equal(odd.manifest.worlds[0].plannedPort, null);
});

test('parseSums accepts only known parts of valid worlds', () => {
  const h = 'a'.repeat(64);
  const sums = m.parseSums([`${h}  worlds/main/saves.tgz`, `${h} *worlds/w2/bepinex.tgz`, `${h}  worlds/main/evil.sh`, `${h}  ../x/saves.tgz`].join('\n'));
  assert.deepEqual(sums, { main: { 'saves.tgz': h }, w2: { 'bepinex.tgz': h } });
});

test('script builders refuse bad tokens and quote every path', () => {
  assert.throws(() => m.exportScript({ token: '1; rm -rf /', worlds: [world()], manifestJson: '{}' }), /bad token/);
  assert.throws(() => m.verifyScript('x'), /bad token/);
  assert.throws(() => m.readBundleCommand('20240101000000', '../etc/passwd'), /bad request/);
  const s = m.importScript({ token: '20240101000000', ts: '20240101000000', w: world(), parts: ['saves.tgz'], oldHome: '/home/old', overwrite: false, doSaves: true, doMods: false });
  assert.match(s, /U='vhserver'/);
  assert.match(s, /IMPORTED main/);
  assert.throws(() => m.importScript({ token: '20240101000000', ts: '20240101000000', w: world(), parts: [], oldHome: '/x/../y', doSaves: true }), /bad old home/);
});

// The archive check runs for real in bash: it must refuse absolute paths, ".." and links that leave the folder.
const SAFE_LISTING_FN = m.importScript({ token: '20240101000000', ts: '20240101000000', w: world(), parts: [], oldHome: '/home/vhserver', doSaves: false, doMods: false })
  .split('\n')
  .filter((l, i, all) => i >= all.findIndex((x) => x.startsWith('safe_listing()')) && i <= all.findIndex((x) => x.startsWith('safe_listing()')) + 3)
  .join('\n');
const hasBash = spawnSync('bash', ['-c', 'command -v awk'], { encoding: 'utf8' }).status === 0;

function listingOk(lines) {
  const r = spawnSync('bash', ['-c', `${SAFE_LISTING_FN}\nsafe_listing`], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  return r.status === 0;
}

test('safe_listing accepts a normal archive', { skip: !hasBash && 'bash/awk not available' }, () => {
  assert.equal(listingOk(['drwxr-xr-x u/u 0 2024-01-01 00:00 ./', '-rw-r--r-- u/u 12 2024-01-01 00:00 ./worlds_local/w.db', 'lrwxrwxrwx u/u 0 2024-01-01 00:00 ./a -> b/c']), true);
});

test('safe_listing refuses paths and links that escape', { skip: !hasBash && 'bash/awk not available' }, () => {
  assert.equal(listingOk(['-rw-r--r-- u/u 12 2024-01-01 00:00 /etc/passwd']), false);
  assert.equal(listingOk(['-rw-r--r-- u/u 12 2024-01-01 00:00 ./a/../../x']), false);
  assert.equal(listingOk(['lrwxrwxrwx u/u 0 2024-01-01 00:00 ./a -> /etc']), false);
  assert.equal(listingOk(['hrw-r--r-- u/u 0 2024-01-01 00:00 ./a link to ../../x']), false);
});
