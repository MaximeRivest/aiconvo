'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');

test('saved search links open the current dialog without requesting a conversation', () => {
  const start = html.indexOf('function dispatchHash(h) {');
  const end = html.indexOf('\nconst $ = id => document.getElementById', start);
  assert.ok(start >= 0 && end > start);
  const queries = [], kinds = [];
  const ctx = vm.createContext({ window: {}, progressStream: null, currentHash: '',
    markSettingsClosed() {}, setRouteKind: kind => kinds.push(kind),
    searchModalOpen: query => queries.push(query),
    open() { throw new Error('Search link treated as a conversation'); },
  });
  new vm.Script(html.slice(start, end)).runInContext(ctx);
  for (const query of ['session abort', 'project:test type:note', '100% ready']) {
    const hash = 'q=' + encodeURIComponent(query);
    ctx.dispatchHash(hash);
    assert.equal(queries.at(-1), query);
    assert.equal(ctx.currentHash, hash);
    assert.equal(kinds.at(-1), 'home');
  }
});
