'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function browser(extra = {}) {
  const context = vm.createContext({
    document: { addEventListener() {} }, setInterval() {},
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    ...extra,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../files-browser.js'), 'utf8'), context);
  return context;
}

test('change ages use relative units, including boundaries and future times', () => {
  const { fbRelativeTime: age } = browser();
  const now = Date.parse('2026-09-11T12:00:00Z');
  for (const [seconds, expected] of [
    [0, 'just now'], [59, 'just now'], [60, '1 min ago'], [180, '3 mins ago'],
    [3599, '59 mins ago'], [3600, '1 hour ago'], [7200, '2 hours ago'],
    [86400, '1 day ago'], [172800, '2 days ago'], [2592000, '1 month ago'],
    [31536000, '1 year ago'], [-180, 'in 3 mins'],
  ]) assert.equal(age(now - seconds * 1000, now), expected);
  assert.equal(age('2026-09-09T12:00:00Z', now), '2 days ago');
  for (const value of [null, undefined, '', 'invalid', NaN]) assert.equal(age(value, now), 'Unknown time');
});

test('time markup retains the exact date and event outcome', () => {
  const context = browser();
  const ts = Date.parse('2026-09-09T12:00:00Z');
  const html = context.fbEventLabel({ actor: 'ai', outcome: 'attempted', ts });
  assert.match(html, /Agent \(attempt recorded\) · <time /);
  assert.ok(html.includes(`data-fb-time="${ts}"`));
  assert.ok(html.includes('datetime="2026-09-09T12:00:00.000Z"'));
  assert.ok(html.includes(`title="${new Date(ts).toLocaleString()}"`));
  assert.equal(context.fbTimeHTML(null), 'Unknown time');
});

test('refresh changes only time text and skips hidden or unrelated views', () => {
  let writes = 0, scans = 0, timer, visibility;
  const el = { dataset: { fbTime: String(Date.now() - 180000) },
    get textContent() { return this.text; }, set textContent(v) { this.text = v; writes++; } };
  const document = { hidden: false, addEventListener: (name, fn) => { visibility = fn; },
    querySelectorAll: () => { scans++; return [el]; } };
  const context = browser({ document, viewKind: 'files-browser',
    setInterval: (fn, ms) => { timer = fn; assert.equal(ms, 30000); } });
  timer(); assert.equal(el.text, '3 mins ago'); assert.equal(writes, 1);
  timer(); assert.equal(writes, 1);
  document.hidden = true; timer(); assert.equal(scans, 2);
  document.hidden = false; visibility(); assert.equal(scans, 3);
  context.viewKind = 'conversation'; timer(); assert.equal(scans, 3);
});
