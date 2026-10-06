'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cmpVersion, entriesFromFolders, planRestore, sameSet } = require('../modsets');

test('cmpVersion compares numerically', () => {
  assert.equal(cmpVersion('1.10.0', '1.9.0'), 1);
  assert.equal(cmpVersion('1.2', '1.2.0'), 0);
  assert.equal(cmpVersion('0.9.9', '1.0.0'), -1);
});

test('entriesFromFolders prefers installedFrom, then the folder name, else not restorable', () => {
  const e = entriesFromFolders(['A-One-1.0.0', 'B-Two-2.0.0', 'HandMade'], { 'B-Two-2.0.0': { source: 'hexium', owner: 'B', name: 'Two', version: '2.0.0' } });
  assert.equal(e.find((x) => x.folder === 'B-Two-2.0.0').source, 'hexium');
  assert.equal(e.find((x) => x.folder === 'A-One-1.0.0').source, null);
  assert.equal(e.find((x) => x.folder === 'HandMade').restorable, false);
});

test('planRestore finds installs, downgrades, upgrades and removals', () => {
  const cur = entriesFromFolders(['A-One-2.0.0', 'B-Two-1.0.0', 'C-Three-1.0.0', 'Manual']);
  const tgt = entriesFromFolders(['A-One-1.0.0', 'B-Two-1.0.0', 'D-Four-3.0.0', 'Gone']);
  const p = planRestore(cur, tgt);
  const by = (a) => p.lines.filter((l) => l.action === a);
  assert.equal(by('downgrade')[0].version, '1.0.0');
  assert.equal(by('downgrade')[0].folder, 'A-One-2.0.0');
  assert.equal(by('install')[0].name, 'Four');
  assert.equal(by('remove')[0].name, 'Three');
  assert.equal(by('manual')[0].folder, 'Gone');
  assert.equal(p.unchanged, 1);
  assert.ok(!p.lines.some((l) => l.folder === 'Manual'), 'hand-named current folders are left alone');
});

test('sameSet ignores order', () => {
  assert.ok(sameSet(entriesFromFolders(['A-One-1.0.0', 'B-Two-1.0.0']), entriesFromFolders(['B-Two-1.0.0', 'A-One-1.0.0'])));
  assert.ok(!sameSet(entriesFromFolders(['A-One-1.0.0']), entriesFromFolders(['A-One-1.1.0'])));
});
