'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, unmanagedModIds, sameSet, planRestore, applyPlan, describe } = require('../pzmodsets');

const current = {
  workshopItems: ['1', '2', '3'],
  mods: ['ModA', 'ModB', 'HandMod', 'OldHand'],
  map: 'Muldraugh, KY',
  sidecar: { 1: { name: 'One', modIds: ['ModA'] }, 2: { name: 'Two', modIds: ['ModB'] }, 3: { name: 'Three', modIds: [] } },
};
const target = {
  workshopItems: ['2', '1', '4'],
  mods: ['ModB', 'ModA', 'ModD', 'HandMod', 'NewHand'],
  map: 'Riverside, KY',
  sidecar: { 1: { name: 'One', modIds: ['ModA'] }, 2: { name: 'Two', modIds: ['ModB'] }, 4: { name: 'Four', modIds: ['ModD'] } },
};

test('normalize trims, de-duplicates and fills missing fields', () => {
  assert.deepEqual(normalize({ workshopItems: [' 1', '1', ''], mods: ['A', 'A'], sidecar: { 1: { modIds: ['A', 'A'] } } }), {
    workshopItems: ['1'],
    mods: ['A'],
    map: '',
    sidecar: { 1: { name: '', modIds: ['A'] } },
  });
});

test('unmanagedModIds are the Mod IDs no Workshop item claims', () => {
  assert.deepEqual(unmanagedModIds(normalize(current)), ['HandMod', 'OldHand']);
});

test('sameSet: load order counts, names and dates do not', () => {
  const renamed = { ...current, sidecar: { ...current.sidecar, 1: { name: 'Renamed', modIds: ['ModA'], addedAt: 'x' } } };
  assert.equal(sameSet(current, renamed), true);
  assert.equal(sameSet(current, { ...current, workshopItems: ['3', '2', '1'] }), false);
});

test('planRestore lists adds, removes, order, hand Mod IDs and the map', () => {
  const { lines, unchanged } = planRestore(current, target);
  assert.deepEqual(lines.map((l) => l.key), ['add:4', 'remove:3', 'order', 'modid-add:NewHand', 'modid-remove:OldHand', 'map']);
  assert.equal(unchanged, 2);
  assert.equal(lines[0].modIdsKnown, true);
});

test('applyPlan applies only the ticked lines', () => {
  const none = applyPlan(current, target, []);
  assert.deepEqual(none.workshopItems, current.workshopItems);
  assert.deepEqual(none.mods, ['ModA', 'ModB', 'HandMod', 'OldHand']);
  assert.equal(none.map, undefined);

  const all = applyPlan(current, target, planRestore(current, target).lines.map((l) => l.key));
  assert.deepEqual(all.workshopItems, ['2', '1', '4']);
  assert.deepEqual(all.mods, ['ModB', 'ModA', 'ModD', 'HandMod', 'NewHand']);
  assert.equal(all.map, 'Riverside, KY');
  assert.deepEqual(Object.keys(all.sidecar).sort(), ['1', '2', '4']);
});

test('applyPlan refuses keys that are not in the plan', () => {
  assert.throws(() => applyPlan(current, target, ['remove:999']), /not part of this restore plan/);
});

test('describe counts items and Mod IDs', () => {
  assert.deepEqual(describe(current), { count: 3, modCount: 4 });
});
