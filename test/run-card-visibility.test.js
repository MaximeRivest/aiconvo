const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const body = source.match(/function hasRunCardContent\(r\) \{([\s\S]*?)\n\}/)[1];
const hasContent = new Function('r', body);

test('ordinary runs do not duplicate the composer activity bar', () => {
  assert.equal(hasContent({}), false);
  assert.equal(hasContent({ uiRequests: [], notices: [], widgets: {}, customViews: {} }), false);
});

test('interactive run content remains visible', () => {
  for (const run of [
    { uiRequests: [{ id: 'question' }] },
    { notices: ['Notice'] },
    { widgets: { status: ['Working'] } },
    { customViews: { prompt: { lines: [] } } },
  ]) assert.equal(hasContent(run), true);
});
