'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

function ruleFor(selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) =>
    selectors.replace(/\/\*[\s\S]*?\*\//g, '').split(',').some(s => s.trim() === selector));
  assert.ok(rules.length, `Missing rule: ${selector}`);
  return rules.map(rule => rule[2]).join('\n');
}

test('zen controls keep their own hiding rule after selector cleanup', () => {
  for (const selector of ['body.zen:not(.home) header', 'body.zen:not(.home) .model-strip',
    'body.zen:not(.home) .agent-compose .ctxmeter']) {
    assert.match(ruleFor(selector), /display:\s*none\s*!important/);
  }
  assert.match(ruleFor('body.zen:not(.home) .transcript'), /border:\s*0/);
});

test('binary row hover remains separate from the note SVG rule', () => {
  assert.match(ruleFor(':root[data-theme-mode="binary"] .item:hover'), /background:\s*transparent/);
  assert.match(ruleFor(':root[data-theme-mode="binary"] .tmark.note .violin'), /fill:/);
});
