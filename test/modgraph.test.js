'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFolder, parseDep, identifyFolder, buildGraph, planRemoval } = require('../modgraph');

const pkg = (owner, name, deps = [], version = '1.0.0') => ({ owner, name, versions: [{ version_number: version, dependencies: deps }] });
const lists = {
  thunderstore: [
    pkg('RandyKnapp', 'EpicLoot', ['denikson-BepInExPack_Valheim-5.4.2200', 'Jotunn-Jotunn-2.20.0']),
    pkg('Jotunn', 'Jotunn', ['denikson-BepInExPack_Valheim-5.4.2200']),
    pkg('Acme', 'Cooking', ['Jotunn-Jotunn-2.20.0', 'Acme-Pots-1.0.0']),
    pkg('Acme', 'Pots', []),
    pkg('Solo', 'Lonely', []),
  ],
  hexium: [pkg('Hex', 'OnlyHere', ['Jotunn-Jotunn-2.20.0'])],
};
const folders = ['RandyKnapp-EpicLoot-1.0.0', 'Jotunn-Jotunn-1.0.0', 'Acme-Cooking-1.0.0', 'Acme-Pots-1.0.0', 'Solo-Lonely-1.0.0'];
const graph = (extra = [], recs = {}) => buildGraph([...folders, ...extra], recs, lists);

test('parseFolder and parseDep handle hyphenated package names', () => {
  assert.deepEqual(parseFolder('Owner-Some-Mod-1.2.3'), { owner: 'Owner', name: 'Some-Mod', version: '1.2.3' });
  assert.equal(parseFolder('HandNamedFolder'), null);
  assert.deepEqual(parseDep('Owner-Some-Mod-1.2.3'), { owner: 'Owner', name: 'Some-Mod', version: '1.2.3' });
});

test('a folder is identified from its record, its name, or a unique bare name', () => {
  const byRec = identifyFolder('whatever', { source: 'hexium', owner: 'Hex', name: 'OnlyHere', version: '1.0.0' }, lists);
  assert.equal(byRec.source, 'hexium');
  assert.equal(identifyFolder('Acme-Pots-1.0.0', null, lists).name, 'Pots');
  assert.equal(identifyFolder('Lonely', null, lists).owner, 'Solo');
  assert.equal(identifyFolder('NoSuchMod', null, lists), null);
  const dup = { thunderstore: [pkg('A', 'Same'), pkg('B', 'Same')], hexium: [] };
  assert.equal(identifyFolder('Same', null, dup), null, 'two owners with the same name is ambiguous');
});

test('the BepInEx framework is never treated as a dependency', () => {
  const j = graph().find((n) => n.folder === 'Jotunn-Jotunn-1.0.0');
  assert.deepEqual(j.deps, []);
});

test('removing a library lists the installed mods that need it', () => {
  const plan = planRemoval(graph(), ['Jotunn-Jotunn-1.0.0']);
  assert.deepEqual(plan.dependents.map((d) => d.folder).sort(), ['Acme-Cooking-1.0.0', 'RandyKnapp-EpicLoot-1.0.0']);
  assert.deepEqual(plan.dependencies, []);
});

test('removing a mod offers libraries only it needs, and keeps shared ones', () => {
  const plan = planRemoval(graph(), ['Acme-Cooking-1.0.0']);
  const byName = Object.fromEntries(plan.dependencies.map((d) => [d.folder, d.neededBy]));
  assert.deepEqual(byName['Acme-Pots-1.0.0'], [], 'Pots is used by nothing else');
  assert.deepEqual(byName['Jotunn-Jotunn-1.0.0'], ['RandyKnapp-EpicLoot-1.0.0'], 'Jotunn is still used by EpicLoot');
});

test('removing both users of a library makes it removable', () => {
  const plan = planRemoval(graph(), ['Acme-Cooking-1.0.0', 'RandyKnapp-EpicLoot-1.0.0']);
  const jot = plan.dependencies.find((d) => d.folder === 'Jotunn-Jotunn-1.0.0');
  assert.deepEqual(jot.neededBy, []);
});

test('an unrelated mod produces an empty plan, and unknown folders are reported', () => {
  const plan = planRemoval(graph(['MysteryFolder']), ['Solo-Lonely-1.0.0']);
  assert.deepEqual(plan.dependents, []);
  assert.deepEqual(plan.dependencies, []);
  assert.deepEqual(planRemoval(graph(['MysteryFolder']), ['MysteryFolder']).unknown, ['MysteryFolder']);
});

test('a mod is never listed as needing itself or as its own library', () => {
  const plan = planRemoval(graph(), ['Acme-Cooking-1.0.0']);
  assert.ok(!plan.dependents.some((d) => d.folder === 'Acme-Cooking-1.0.0'));
  assert.ok(!plan.dependencies.some((d) => d.folder === 'Acme-Cooking-1.0.0'));
});
