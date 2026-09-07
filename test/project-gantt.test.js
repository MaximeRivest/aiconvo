const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../app.html'), 'utf8');
const source = html.slice(html.indexOf('function mgPaintOpen('), html.indexOf('// Ticks for the open hero.'));
function render(query = '') {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { scrollTop: 0, scrollLeft: 0, addEventListener() {}, focus() {} });
    return nodes.get(selector);
  };
  const host = { clientWidth: 1200, setAttribute() {}, removeAttribute() {}, querySelector: node, querySelectorAll: () => [], innerHTML: '' };
  const items = [{ key: 'a', title: 'Long useful conversation title about navigation', timelineTitle: 'Nav', a: Date.now() - 30 * 86400000, b: Date.now() - 29 * 86400000 }];
  const context = { host, items, sessions: items, mgUI: { zoom: 1, query }, matchMedia: () => ({ matches: false }), Date, Map, Math, esc: x => String(x), isActive: () => false, violinPath: () => '', mgTicks: () => '', mgTip: () => '', hideMarkPop() {}, mgCollapseOpen() {} };
  vm.createContext(context);
  vm.runInContext(source + '\nmgPaintOpen(host, items, {stroke:"black",fill:"black"});', context);
  return { host, context };
}
test('expanded project timeline uses readable titles and starts with a week, not the whole history', () => {
  const { host, context } = render();
  assert.ok(context.mgUI.zoom > 4);
  assert.match(host.innerHTML, /Long useful conversation title abou/);
  assert.doesNotMatch(host.innerHTML, /max-height:/);
  assert.match(host.innerHTML, /tabindex="0" aria-label="Project conversation timeline"/);
});
test('title search filters marks without changing the history scale', () => {
  const { host } = render('missing');
  assert.match(host.innerHTML, /0 conversations/);
  assert.doesNotMatch(host.innerHTML, /data-mg="a"/);
  assert.match(render('navigation').host.innerHTML, /data-mg="a"/);
});
test('inline scripts compile', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(match[1])) new Function(match[2]);
  }
});
