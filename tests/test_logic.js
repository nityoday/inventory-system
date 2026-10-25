// Run with:  node tests/test_logic.js      (needs Node 16+, optional)
const assert = require('assert');
const L = require('../static/logic.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const T = (id, name) => ({ id, name, color: '#b91c1c', createdAt: '2026-01-01T00:00:00Z' });
const E = (id, name, parentId = null, tagIds = [], description = '') => ({
  id, name, description, parentId, tagIds, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const names = (arr) => arr.map((x) => x.name);

// Cabinet A (Gift) > Box B > Item C ;  Cabinet A > Item D (Electronics)
const base = () => ({
  tags: [T('gift', 'Gift'), T('elec', 'Electronics')],
  entries: [
    E('A', 'Cabinet A', null, ['gift']),
    E('B', 'Box B', 'A'),
    E('C', 'Item C', 'B'),
    E('D', 'Item D', 'A', ['elec']),
  ],
});

test('effective tags: direct vs inherited', () => {
  const idx = L.buildIndex(base());
  let t = idx.effectiveTags('A');
  assert.deepStrictEqual(names(t.direct), ['Gift']);
  assert.strictEqual(t.inherited.length, 0);
  t = idx.effectiveTags('B');
  assert.strictEqual(t.direct.length, 0);
  assert.deepStrictEqual(t.inherited.map((x) => [x.tag.name, x.from.name]), [['Gift', 'Cabinet A']]);
  t = idx.effectiveTags('C');
  assert.deepStrictEqual(t.inherited.map((x) => [x.tag.name, x.from.name]), [['Gift', 'Cabinet A']]);
  t = idx.effectiveTags('D');
  assert.deepStrictEqual(names(t.direct), ['Electronics']);
  assert.deepStrictEqual(t.inherited.map((x) => x.tag.name), ['Gift']);
});

test('inherited tags are never stored on entries', () => {
  const s = base();
  L.buildIndex(s);
  assert.deepStrictEqual(s.entries.find((e) => e.id === 'B').tagIds, []);
});

test('searching by tag returns the tagged entry and every descendant', () => {
  const idx = L.buildIndex(base());
  const r = L.search(idx, { query: 'gift', tagIds: [] });
  assert.deepStrictEqual([...r.matches.keys()].sort(), ['A', 'B', 'C', 'D']);
  const rb = r.matches.get('B');
  assert.strictEqual(rb.tags[0].from.name, 'Cabinet A');   // inherited, with its source
  assert.strictEqual(r.matches.get('A').tags[0].from, null); // direct
  const f = L.search(idx, { query: '', tagIds: ['gift'] });
  assert.strictEqual(f.count, 4);
});

test('removing an ancestor tag stops inheritance (no rewrite of descendants)', () => {
  const s = base();
  s.entries[0].tagIds = [];
  const idx = L.buildIndex(s);
  assert.strictEqual(L.search(idx, { query: '', tagIds: ['gift'] }).count, 0);
  assert.strictEqual(idx.effectiveTags('C').inherited.length, 0);
});

test('another ancestor keeps the tag alive', () => {
  const s = base();
  s.entries[0].tagIds = [];
  s.entries.find((e) => e.id === 'B').tagIds = ['gift'];
  const idx = L.buildIndex(s);
  const r = L.search(idx, { query: '', tagIds: ['gift'] });
  assert.deepStrictEqual([...r.matches.keys()].sort(), ['B', 'C']);
  assert.strictEqual(r.matches.get('C').tags[0].from.name, 'Box B');
});

test('nearest ancestor is reported; a direct tag beats an inherited one', () => {
  const s = base();
  s.entries.find((e) => e.id === 'B').tagIds = ['gift'];
  const idx = L.buildIndex(s);
  assert.strictEqual(idx.effectiveTags('C').inherited[0].from.name, 'Box B');
  const b = idx.effectiveTags('B');
  assert.deepStrictEqual(names(b.direct), ['Gift']);
  assert.strictEqual(b.inherited.length, 0);
});

test('deleting a tag removes inheritance', () => {
  const s = base();
  s.tags = s.tags.filter((t) => t.id !== 'gift');
  s.entries.forEach((e) => (e.tagIds = e.tagIds.filter((t) => t !== 'gift')));
  const idx = L.buildIndex(s);
  assert.strictEqual(idx.effectiveTags('C').inherited.length, 0);
});

test('moving a subtree changes inherited tags immediately', () => {
  const s = base();
  s.entries.push(E('R', 'Other root'));
  s.entries.find((e) => e.id === 'B').parentId = 'R';
  const idx = L.buildIndex(s);
  assert.strictEqual(idx.effectiveTags('C').inherited.length, 0);
  assert.deepStrictEqual(idx.pathTo('C').map((e) => e.id), ['R', 'B', 'C']);
});

test('text search: name, description, partial, case-insensitive, no duplicates', () => {
  const s = {
    tags: [T('g', 'Gift')],
    entries: [
      E('p1', 'Property 203'),
      E('b1', 'Bedroom', 'p1'),
      E('p2', 'Property 303'),
      E('b2', 'Bedroom', 'p2'),
      E('x', 'Blue Box', 'b2', ['g'], 'Holds an old USB cable and a gift card'),
      E('cab', 'Cable', 'x'),
      E('gift', 'Gift', 'b1', ['g']),
    ],
  };
  const idx = L.buildIndex(s);
  assert.deepStrictEqual([...L.search(idx, { query: '  BEDROOM ' }).matches.keys()].sort(), ['b1', 'b2']);
  const cable = L.search(idx, { query: 'cable' });
  assert.deepStrictEqual([...cable.matches.keys()].sort(), ['cab', 'x']);
  assert.ok(cable.matches.get('x').snippet.toLowerCase().includes('cable'));
  const gift = L.search(idx, { query: 'gift' });
  assert.strictEqual(gift.count, gift.matches.size);
  assert.deepStrictEqual([...gift.matches.keys()].sort(), ['cab', 'gift', 'x']);
  assert.ok(L.search(idx, { query: 'ble ca' }).matches.has('x'));          // each word matches somewhere
  assert.strictEqual(L.search(idx, { query: 'zzz' }).count, 0);
  assert.strictEqual(L.search(idx, { query: '   ' }), null);
});

test('context ancestors are visible but not matches', () => {
  const idx = L.buildIndex(base());
  const r = L.search(idx, { query: 'box b' });
  assert.deepStrictEqual([...r.matches.keys()], ['B']);
  assert.deepStrictEqual([...r.visible].sort(), ['A', 'B']);   // Cabinet A is context only
});

test('tag filters are OR; combined with text they are AND', () => {
  const idx = L.buildIndex(base());
  const or = L.search(idx, { query: '', tagIds: ['gift', 'elec'] });
  assert.strictEqual(or.count, 4);
  const only = L.search(idx, { query: '', tagIds: ['elec'] });
  assert.deepStrictEqual([...only.matches.keys()], ['D']);
  const both = L.search(idx, { query: 'item', tagIds: ['gift'] });
  assert.deepStrictEqual([...both.matches.keys()].sort(), ['C', 'D']);
  const none = L.search(idx, { query: 'cabinet', tagIds: ['elec'] });
  assert.strictEqual(none.count, 0);
});

test('siblings sort case-insensitively, naturally, deterministically', () => {
  const s = { tags: [], entries: [E('1', 'beta'), E('2', 'Alpha'), E('3', 'Drawer 10'), E('4', 'Drawer 2'), E('6', 'Same'), E('5', 'same')] };
  const idx = L.buildIndex(s);
  assert.deepStrictEqual(names(idx.roots), ['Alpha', 'beta', 'Drawer 2', 'Drawer 10', 'same', 'Same']);
  const again = L.buildIndex({ tags: [], entries: s.entries.slice().reverse() });
  assert.deepStrictEqual(idx.roots.map((e) => e.id), again.roots.map((e) => e.id));
});

test('very deep hierarchy is handled iteratively', () => {
  const entries = [];
  for (let i = 0; i < 20000; i++) entries.push(E('e' + i, 'L' + i, i ? 'e' + (i - 1) : null, i === 0 ? ['gift'] : []));
  const idx = L.buildIndex({ tags: [T('gift', 'Gift')], entries });
  assert.strictEqual(idx.descendantCount('e0'), 19999);
  assert.strictEqual(idx.pathTo('e19999').length, 20000);
  assert.strictEqual(idx.effectiveTags('e19999').inherited[0].from.name, 'L0');
  assert.strictEqual(L.search(idx, { query: '', tagIds: ['gift'] }).count, 20000);
});

test('isInside and descendant counts', () => {
  const idx = L.buildIndex(base());
  assert.ok(idx.isInside('C', 'A'));
  assert.ok(idx.isInside('A', 'A'));
  assert.ok(!idx.isInside('A', 'C'));
  assert.strictEqual(idx.descendantCount('A'), 3);
  assert.strictEqual(idx.descendantCount('D'), 0);
});

test('highlightParts', () => {
  const p = L.highlightParts('Blue Box and blue pen', ['blue', 'pen']);
  assert.deepStrictEqual(p.filter((x) => x.hit).map((x) => x.text), ['Blue', 'blue', 'pen']);
  assert.strictEqual(p.map((x) => x.text).join(''), 'Blue Box and blue pen');
  assert.deepStrictEqual(L.highlightParts('abc', []), [{ text: 'abc', hit: false }]);
});

test('text colour keeps contrast', () => {
  assert.strictEqual(L.textColorFor('#b91c1c'), '#ffffff');
  assert.strictEqual(L.textColorFor('#fde047'), '#111827');
  assert.strictEqual(L.textColorFor('garbage'), '#ffffff');
});

test('ids like __proto__ do not break lookups', () => {
  const s = { tags: [], entries: [E('__proto__', 'Weird'), E('constructor', 'Odd', '__proto__')] };
  const idx = L.buildIndex(s);
  assert.deepStrictEqual(idx.pathTo('constructor').map((e) => e.name), ['Weird', 'Odd']);
});

console.log(`\n${n} tests passed`);
