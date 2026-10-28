'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { norm, parseDep, parseFolder, identifyFolder, buildGraph, planRemoval } = require('../modgraph');

const pkg = (owner, name, versions) => ({ owner, name, versions: versions.map(([v, deps]) => ({ version_number: v, dependencies: deps || [] })) });

const lists = {
  thunderstore: [
    pkg('ValheimModding', 'Jotunn', [['2.20.0']]),
    pkg('Azumatt', 'AzuCraftyBoxes', [['1.5.0', ['denikson-BepInExPack_Valheim-5.4.2202', 'ValheimModding-Jotunn-2.20.0']], ['1.4.0', []]]),
    pkg('Someone', 'SharedName', [['1.0.0']]),
  ],
  hexium: [
    pkg('Odin', 'OdinHorse', [['1.7.1', ['ValheimModding-Jotunn-2.20.0']]]),
    pkg('Other', 'SharedName', [['2.0.0']]),
  ],
};

test('norm keeps only lowercase letters and digits', () => {
  assert.equal(norm('Azu_Crafty-Boxes 1.0'), 'azucraftyboxes10');
  assert.equal(norm(null), '');
});

test('parseDep keeps hyphens inside the package name', () => {
  assert.deepEqual(parseDep('Owner-Some-Name-1.2.3'), { owner: 'Owner', name: 'Some-Name', version: '1.2.3' });
});

test('parseFolder reads GUI-written folders and rejects hand-named ones', () => {
  assert.deepEqual(parseFolder('Azumatt-AzuCraftyBoxes-1.5.0'), { owner: 'Azumatt', name: 'AzuCraftyBoxes', version: '1.5.0' });
  assert.deepEqual(parseFolder('A-B-C-1.0'), { owner: 'A', name: 'B-C', version: '1.0' });
  assert.equal(parseFolder('AAA_Crafting'), null);
  assert.equal(parseFolder('Name-1.0'), null);
  assert.equal(parseFolder('Owner-Name-beta'), null);
});

test('identifyFolder prefers the installedFrom record over the folder name', () => {
  const id = identifyFolder('Azumatt-AzuCraftyBoxes-1.5.0', { source: 'hexium', owner: 'Odin', name: 'OdinHorse', version: '1.7.1' }, lists);
  assert.equal(id.source, 'hexium');
  assert.equal(id.name, 'OdinHorse');
});

test('identifyFolder uses the dependencies of the installed version and drops BepInExPack', () => {
  const id = identifyFolder('Azumatt-AzuCraftyBoxes-1.5.0', null, lists);
  assert.equal(id.source, 'thunderstore');
  assert.deepEqual(id.deps.map((d) => d.name), ['Jotunn']);
  assert.deepEqual(identifyFolder('Azumatt-AzuCraftyBoxes-1.4.0', null, lists).deps, []);
});

test('identifyFolder matches a hand-named folder only when exactly one package has that name', () => {
  assert.equal(identifyFolder('Jotunn', null, lists).owner, 'ValheimModding');
  assert.equal(identifyFolder('SharedName', null, lists), null);
  assert.equal(identifyFolder('NothingLikeThis', null, lists), null);
  assert.equal(identifyFolder('', null, lists), null);
});

test('planRemoval lists dependents and libraries still needed by others', () => {
  const nodes = buildGraph(['ValheimModding-Jotunn-2.20.0', 'Azumatt-AzuCraftyBoxes-1.5.0', 'Odin-OdinHorse-1.7.1', 'Mystery'], {}, lists);
  const jot = planRemoval(nodes, ['ValheimModding-Jotunn-2.20.0']);
  assert.deepEqual(jot.dependents.map((d) => d.folder).sort(), ['Azumatt-AzuCraftyBoxes-1.5.0', 'Odin-OdinHorse-1.7.1']);
  assert.deepEqual(jot.dependencies, []);

  const boxes = planRemoval(nodes, ['Azumatt-AzuCraftyBoxes-1.5.0']);
  assert.deepEqual(boxes.dependents, []);
  assert.deepEqual(boxes.dependencies, [{ folder: 'ValheimModding-Jotunn-2.20.0', neededBy: ['Odin-OdinHorse-1.7.1'] }]);

  assert.deepEqual(planRemoval(nodes, ['Mystery']).unknown, ['Mystery']);
});
