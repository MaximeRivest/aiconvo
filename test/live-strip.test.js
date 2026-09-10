const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual renderer with a small DOM double. Missing selectors
// fail loudly, including when a reused block number has the wrong row shape.
class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.nodes = new Map();
    this.scrollHeight = 1000; this.clientHeight = 200; this.scrollTop = 0;
    this.classList = { contains: () => false, toggle() {} };
    this.resets = 0;
  }
  set innerHTML(html) {
    this.nodes.clear();
    for (const [, cls] of html.matchAll(/class="([^"]+)"/g)) this.nodes.set('.' + cls, new Element());
  }
  querySelector(selector) {
    if (selector.startsWith('[data-blk=')) {
      const id = selector.slice(11, -2);
      return this.children.find(el => el.dataset.blk === id) || null;
    }
    return this.nodes.get(selector) || null;
  }
  appendChild(el) { this.children.push(el); }
  replaceChildren() { this.children = []; this.resets++; }
}
function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
  const start = source.indexOf('function renderLsBlocks(');
  const end = source.indexOf('\nfunction parallelLedgersFor(', start);
  const host = new Element(), chip = { hidden: false };
  const ctx = vm.createContext({
    $: id => ({ lsBlocks: host, lsChip: chip })[id],
    document: { createElement: () => new Element() }, CSS: { escape: s => s },
    setLiveText: (node, text) => { assert.ok(node, 'row must have the correct shape'); node.textContent = text; },
    StreamingTool: { render: node => assert.ok(node), cleanOutput: s => s },
    diffLinesAsync() {}, fmtElapsed: () => '1s',
  });
  vm.runInContext(source.slice(start, end), ctx);
  return { render: ctx.renderLsBlocks, host, chip };
}
const ledger = (...blocks) => ({ order: blocks.map(b => String(b.id)), blocks: new Map(blocks.map(b => [String(b.id), b])) });

test('a new run replaces old rows even when block numbers and kinds overlap', () => {
  const { render, host } = setup();
  render(ledger({ id: 1, kind: 'text', text: 'old reply' }, { id: 2, kind: 'tool', name: 'old tool' }));
  const oldRow = host.children[0];
  render(ledger({ id: 1, kind: 'tool', name: 'new tool', phase: 'running' }));
  assert.equal(host.children.length, 1);
  assert.notEqual(host.children[0], oldRow);
  assert.match(host.children[0].querySelector('.ls-b-head').textContent, /new tool/);
});

test('same-run updates preserve existing rows and an unpinned reading position', () => {
  const { render, host } = setup();
  const L = ledger({ id: 1, kind: 'text', think: 'first', text: 'reply' });
  render(L);
  const row = host.children[0], resets = host.resets;
  host.scrollTop = 123;
  L.blocks.set('1', { id: 1, kind: 'text', think: 'updated', text: 'reply' });
  render(L);
  assert.equal(host.children[0], row);
  assert.equal(host.resets, resets);
  assert.equal(host.scrollTop, 123);
  assert.equal(row.querySelector('.ls-think').textContent, 'updated');
  assert.equal(row.querySelector('.ls-text').textContent, '');
});

test('waiting for a new ledger clears stale contents and the live-scroll button', () => {
  const { render, host, chip } = setup();
  render(ledger({ id: 1, kind: 'text', text: 'finished' }));
  chip.hidden = false;
  render(null);
  assert.equal(host.children.length, 0);
  assert.equal(chip.hidden, true);
});

test('parallel hosts own their ledgers independently and a rebuilt host repopulates', () => {
  const { render } = setup();
  const a = new Element(), b = new Element();
  const first = ledger({ id: 1, kind: 'text', text: 'A' });
  const second = ledger({ id: 1, kind: 'tool', name: 'B' });
  render(first, a); render(second, b);
  const rowB = b.children[0];
  render(second, a);
  render(second, b);
  assert.equal(b.children[0], rowB);
  const reopened = new Element();
  render(second, reopened);
  assert.equal(reopened.children.length, 1);
  assert.match(reopened.children[0].querySelector('.ls-b-head').textContent, /B/);
});
