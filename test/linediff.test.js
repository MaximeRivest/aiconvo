const test = require('node:test');
const assert = require('node:assert/strict');
const LD = require('../linediff.js');

function check(oldLines, newLines) {
  const script = LD.diffLineArrays(oldLines, newLines);
  const back = LD.applyScript(script, oldLines, newLines);
  assert.equal(back.consumedOld, oldLines.length, 'every old line is consumed');
  assert.equal(back.consumedNew, newLines.length, 'every new line is consumed');
  assert.deepEqual(back.oldLines, oldLines);
  assert.deepEqual(back.newLines, newLines);
  let i = 0, j = 0;
  for (const op of script) {
    if (op === LD.SAME) assert.equal(oldLines[i], newLines[j], 'a same op joins equal lines');
    if (op !== LD.NEW) i++;
    if (op !== LD.OLD) j++;
  }
  return script;
}

test('identical, empty, and one-sided inputs', () => {
  assert.deepEqual(LD.scriptStats(check([], [])), { same: 0, removed: 0, added: 0 });
  assert.deepEqual(LD.scriptStats(check(['a', 'b'], ['a', 'b'])), { same: 2, removed: 0, added: 0 });
  assert.deepEqual(LD.scriptStats(check(['a', 'b'], [])), { same: 0, removed: 2, added: 0 });
  assert.deepEqual(LD.scriptStats(check([], ['a', 'b'])), { same: 0, removed: 0, added: 2 });
});

test('classic Myers example is minimal', () => {
  const script = check('ABCABBA'.split(''), 'CBABAC'.split(''));
  const stats = LD.scriptStats(script);
  assert.equal(stats.removed + stats.added, 5);
});

test('insert, delete, and replace in the middle keep the surrounding lines as same', () => {
  const base = ['function f() {', '  const a = 1;', '  return a;', '}'];
  const inserted = ['function f() {', '  const a = 1;', '  const b = 2;', '  return a;', '}'];
  assert.deepEqual(Array.from(check(base, inserted)), [0, 0, 2, 0, 0]);
  assert.deepEqual(Array.from(check(inserted, base)), [0, 0, 1, 0, 0]);
  const replaced = ['function f() {', '  const a = 2;', '  return a;', '}'];
  assert.deepEqual(Array.from(check(base, replaced)), [0, 1, 2, 0, 0]);
});

test('lines that occur on only one side are decided before the search and stay in order', () => {
  const oldLines = ['x', 'only-old-1', 'y', 'only-old-2', 'z'];
  const newLines = ['only-new-1', 'x', 'y', 'only-new-2', 'z'];
  const script = check(oldLines, newLines);
  assert.deepEqual(LD.scriptStats(script), { same: 3, removed: 2, added: 2 });
});

test('repeated lines (braces, blanks) do not confuse the alignment', () => {
  const oldLines = ['if (a) {', '}', '', 'if (b) {', '  one();', '}', '', 'if (c) {', '}'];
  const newLines = ['if (a) {', '}', '', 'if (b) {', '  one();', '  two();', '}', '', 'if (c) {', '}'];
  assert.deepEqual(Array.from(check(oldLines, newLines)), [0, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
});

test('diffLines splits text on newlines and keeps a trailing newline as an empty last line', () => {
  const script = LD.diffLines('a\nb\n', 'a\nc\n');
  assert.deepEqual(Array.from(script), [0, 1, 2, 0]);
  assert.deepEqual(LD.scriptStats(LD.diffLines(null, undefined)), { same: 1, removed: 0, added: 0 });
});

test('large inputs are never truncated and stay fast', () => {
  const oldLines = [];
  for (let i = 0; i < 20000; i++) oldLines.push(`line ${i % 700} ${i % 13 === 0 ? '{' : 'x = ' + (i * 7) % 101};`);
  const newLines = oldLines.slice();
  for (let i = 0; i < 20000; i += 37) newLines[i] = 'changed ' + i;
  for (let i = 0; i < 3000; i++) newLines.splice(100 + i * 5, 0, 'inserted ' + i);
  const started = Date.now();
  const script = check(oldLines, newLines);
  const stats = LD.scriptStats(script);
  assert.ok(Date.now() - started < 2000, 'diff of 20k+23k lines finishes quickly');
  assert.equal(stats.same + stats.removed, oldLines.length);
  assert.equal(stats.same + stats.added, newLines.length);
  assert.ok(stats.removed <= 600 && stats.added <= 3600, 'the script is close to minimal: ' + JSON.stringify(stats));
});

test('random inputs always round-trip', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 400; t++) {
    const alpha = 2 + rand(9);
    const oldLines = Array.from({ length: rand(50) }, () => String.fromCharCode(97 + rand(alpha)));
    const newLines = t % 2 ? oldLines.slice() : Array.from({ length: rand(50) }, () => String.fromCharCode(97 + rand(alpha)));
    if (t % 2) for (let e = rand(8); e > 0; e--) { const at = rand(newLines.length + 1); if (rand(2)) newLines.splice(at, 1); else newLines.splice(at, 0, String.fromCharCode(97 + rand(alpha))); }
    check(oldLines, newLines);
  }
});
