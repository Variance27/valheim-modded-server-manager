'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cmpVersion, entriesFromFolders, planRestore, sameSet } = require('../modsets');

test('cmpVersion compares numerically, not as text', () => {
  assert.equal(cmpVersion('1.10.0', '1.9.0'), 1);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(cmpVersion('0.9', '1'), -1);
  assert.equal(cmpVersion(null, ''), 0);
});

test('entriesFromFolders: records win, GUI folders are restorable, hand-named ones are not', () => {
  const e = entriesFromFolders(['b-Hand', 'Owner-Mod-1.0.0', 'Rec', 'Owner-Mod-1.0.0'], { Rec: { source: 'hexium', owner: 'O', name: 'R', version: 2 } });
  assert.deepEqual(e.map((x) => x.folder), ['b-Hand', 'Owner-Mod-1.0.0', 'Rec']);
  assert.equal(e[0].restorable, false);
  assert.equal(e[1].source, null);
  assert.deepEqual(e[2], { folder: 'Rec', owner: 'O', name: 'R', version: '2', source: 'hexium', restorable: true });
});

test('planRestore produces every kind of line in a fixed order', () => {
  const current = entriesFromFolders(['A-Newer-2.0.0', 'A-Older-1.0.0', 'A-Same-1.0.0', 'A-Extra-1.0.0', 'HandNow']);
  const target = entriesFromFolders(['A-Newer-1.0.0', 'A-Older-1.5.0', 'A-Same-1.0.0', 'A-Missing-3.0.0', 'HandGone', 'HandNow']);
  const { lines, unchanged } = planRestore(current, target);
  assert.deepEqual(lines.map((l) => `${l.action}:${l.name}`), ['downgrade:Newer', 'upgrade:Older', 'install:Missing', 'remove:Extra', 'manual:HandGone']);
  assert.equal(unchanged, 2); // A-Same and HandNow
  assert.equal(lines[0].from, '2.0.0');
  assert.equal(lines[0].folder, 'A-Newer-2.0.0');
});

test('planRestore matches packages case- and punctuation-insensitively', () => {
  const { lines } = planRestore(entriesFromFolders(['azumatt-azu_boxes-1.0.0']), entriesFromFolders(['Azumatt-AzuBoxes-1.0.0']));
  assert.deepEqual(lines, []);
});

test('sameSet ignores order but not versions', () => {
  const a = entriesFromFolders(['X-A-1.0.0', 'X-B-1.0.0']);
  assert.equal(sameSet(a, [...a].reverse()), true);
  assert.equal(sameSet(a, entriesFromFolders(['X-A-1.0.0', 'X-B-1.0.1'])), false);
});
