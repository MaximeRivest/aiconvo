'use strict';
// Links inside an open markdown document: the MRMD bundle dispatches
// `file-link-navigate` with the raw `[text](target)` target and aiconvo
// resolves it against the open file, checks it on the server, and opens it
// in the same editor. These tests run the production filesmode.js in a vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function workspace(extra = {}) {
  const context = vm.createContext({ window: {}, document: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { setItem() {}, removeItem() {} },
    URLSearchParams, ...extra });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../filesmode.js'), 'utf8'), context);
  return context;
}
// Values built inside the vm have another realm's prototypes; compare their shape.
const plain = value => JSON.parse(JSON.stringify(value));

test('a link target is read the way markdown wrote it', () => {
  const c = workspace();
  const target = s => plain(c.parseFileLinkTarget(s));
  assert.deepEqual(target('../adr/0011-x.md'), { path: '../adr/0011-x.md', fragment: '' });
  assert.deepEqual(target('notes.md#L12'), { path: 'notes.md', fragment: 'L12' });
  assert.deepEqual(target('notes.md#some-heading?x=1'), { path: 'notes.md', fragment: 'some-heading?x=1' });
  assert.deepEqual(target('notes.md?v=2#top'), { path: 'notes.md', fragment: 'top' });
  assert.deepEqual(target('<my notes.md>'), { path: 'my notes.md', fragment: '' });
  assert.deepEqual(target('a.md "The title"'), { path: 'a.md', fragment: '' });
  assert.deepEqual(target("a.md 'The title'"), { path: 'a.md', fragment: '' });
  assert.deepEqual(target('my%20notes.md#caf%C3%A9'), { path: 'my notes.md', fragment: 'café' });
  assert.deepEqual(target('50%_done.md'), { path: '50%_done.md', fragment: '' }, 'a bad escape is kept literally');
  assert.deepEqual(target('#only-a-fragment'), { path: '', fragment: 'only-a-fragment' });
});

test('a relative target resolves against the open document, never above the root', () => {
  const c = workspace();
  const doc = '/home/u/repo/docs/project/rfc.md';
  assert.equal(c.resolveDocRelative(doc, 'other.md'), '/home/u/repo/docs/project/other.md');
  assert.equal(c.resolveDocRelative(doc, './other.md'), '/home/u/repo/docs/project/other.md');
  assert.equal(c.resolveDocRelative(doc, '../adr/0011.md'), '/home/u/repo/docs/adr/0011.md');
  assert.equal(c.resolveDocRelative(doc, '../../README.md'), '/home/u/repo/README.md');
  assert.equal(c.resolveDocRelative(doc, '../../../../../../../etc/passwd'), '/etc/passwd', '.. stops at the root');
  assert.equal(c.resolveDocRelative(doc, '/abs/file.md'), '/abs/file.md');
  assert.equal(c.resolveDocRelative(doc, 'a//b/./c.md'), '/home/u/repo/docs/project/a/b/c.md');
  assert.equal(c.resolveDocRelative(doc, '~/notes/x.md'), '~/notes/x.md', 'the server expands ~');
  assert.equal(c.resolveDocRelative(doc, ''), '');
});

test('heading fragments find the heading line the way GitHub slugs them', () => {
  const c = workspace();
  const text = [
    '---', 'title: front matter', '# not a heading', '---',
    '# RFC03 — owner-supported local task-session contract', // 5
    '', '```md', '# fenced, ignored', '```',
    '## 1. Candidate, decision requested and limits', // 10
    'Setext heading', '==============', // 11
    '## Repeated', '## Repeated', // 13, 14
    '### With [a link](x.md) and <b>tags</b> and ümlauts', // 15
  ].join('\n');
  assert.equal(c.findHeadingLine(text, 'rfc03--owner-supported-local-task-session-contract'), 5, 'same slug as the Pi opener');
  assert.equal(c.findHeadingLine(text, 'RFC03 — owner-supported local task-session contract'), 5, 'exact heading text');
  assert.equal(c.findHeadingLine(text, 'not-a-heading'), null, 'front matter is skipped');
  assert.equal(c.findHeadingLine(text, 'fenced-ignored'), null, 'fenced code is skipped');
  assert.equal(c.findHeadingLine(text, '1-candidate-decision-requested-and-limits'), 10);
  assert.equal(c.findHeadingLine(text, 'setext-heading'), 11);
  assert.equal(c.findHeadingLine(text, 'repeated'), 13);
  assert.equal(c.findHeadingLine(text, 'repeated-1'), 14);
  assert.equal(c.findHeadingLine(text, 'with-a-link-and-tags-and-ümlauts'), 15);
  assert.equal(c.findHeadingLine(text, 'missing'), null);
});

function following(extra = {}) {
  const calls = { exists: [], navigate: [], native: [], errors: [], toasts: [], reads: [] };
  const ws = { path: '/home/u/repo/docs/rfc.md', project: 'repo', touched: { repoRoot: '/home/u/repo' } };
  const c = workspace({
    postJson: async (url, body) => { calls.exists.push(body.paths[0]); return extra.exists(body.paths[0]); },
    fetch: async url => { calls.reads.push(url); return { json: async () => extra.read ? extra.read(url) : { error: 'no read' } }; },
    liveFileNavigate: (w, location) => { calls.navigate.push(location); return 'navigated'; },
    runNativePathAction: (ctx, action) => { calls.native.push([ctx.path, action]); },
    errToast: m => calls.errors.push(m), toast: m => calls.toasts.push(m),
  });
  vm.runInContext('fileWs = ws', Object.assign(c, { ws }));
  return { c, ws, calls };
}

test('a plain click opens the linked file in this editor, at the top, with a way back', async () => {
  const { c, ws, calls } = following({ exists: p => ({ found: { [p]: { path: p, kind: 'file' } } }) });
  assert.equal(await c.fileWsFollowLink(ws, '../adr/0011.md'), 'navigated');
  assert.deepEqual(calls.exists, ['/home/u/repo/adr/0011.md']);
  assert.deepEqual(plain(calls.navigate), [{ path: '/home/u/repo/adr/0011.md', line: 1 }]);
  assert.deepEqual(calls.errors, []);
});

test('the server-resolved path wins (symlinks, case), and #L12 names the line', async () => {
  const { c, ws, calls } = following({ exists: p => ({ found: { [p]: { path: '/real' + p, kind: 'file' } } }) });
  await c.fileWsFollowLink(ws, 'notes.md#L12');
  assert.deepEqual(plain(calls.navigate), [{ path: '/real/home/u/repo/docs/notes.md', line: 12 }]);
  await c.fileWsFollowLink(ws, 'notes.md#7-9');
  assert.equal(calls.navigate[1].line, 7, 'a range starts at its first line');
});

test('a heading fragment reads the target once and lands on the heading', async () => {
  const { c, ws, calls } = following({
    exists: p => ({ found: { [p]: { path: p, kind: 'file' } } }),
    read: () => ({ text: '# Intro\n\n## Details\n', sha: 'x' }),
  });
  await c.fileWsFollowLink(ws, 'notes.md#details');
  assert.equal(calls.reads.length, 1);
  assert.deepEqual(plain(calls.navigate), [{ path: '/home/u/repo/docs/notes.md', line: 3 }]);
  await c.fileWsFollowLink(ws, 'notes.md#missing');
  assert.equal(calls.navigate[1].line, 1, 'an unknown heading still opens the file');
  assert.deepEqual(calls.toasts, ['heading not found · opening notes.md']);
  const unreadable = following({ exists: p => ({ found: { [p]: { path: p, kind: 'file' } } }), read: () => ({ error: 'outside every project' }) });
  await unreadable.c.fileWsFollowLink(unreadable.ws, 'notes.md#details');
  assert.equal(unreadable.calls.navigate[0].line, 1, 'a target that cannot be read for its heading still opens');
  assert.deepEqual(unreadable.calls.toasts, ['could not read the target for its heading · opening notes.md']);
});

test('dead, folder, and unreachable targets say so and stay put', async () => {
  const { c, ws, calls } = following({ exists: p => (p.endsWith('dir') ? { found: { [p]: { path: p, kind: 'directory' } } } : { found: { [p]: null } }) });
  await c.fileWsFollowLink(ws, 'gone.md');
  await c.fileWsFollowLink(ws, 'somedir');
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.errors, ['link target not found · gone.md', 'folders have no in-app view · somedir']);
  const failing = following({ exists: () => { throw new Error('offline'); } });
  await failing.c.fileWsFollowLink(failing.ws, 'x.md');
  assert.deepEqual(failing.calls.errors, ['could not check the link · x.md']);
  const refused = following({ exists: () => ({ error: 'this path is outside your home, tmp, and projects' }) });
  await refused.c.fileWsFollowLink(refused.ws, '/etc/hosts');
  assert.deepEqual(refused.calls.errors, ['this path is outside your home, tmp, and projects']);
});

test('Ctrl/Cmd-click hands the file to the system application, like every file control', async () => {
  const { c, ws, calls } = following({ exists: p => ({ found: { [p]: { path: p, kind: 'file' } } }) });
  await c.fileWsFollowLink(ws, 'diagram.svg', { system: true });
  assert.deepEqual(calls.native, [['/home/u/repo/docs/diagram.svg', 'open']]);
  assert.deepEqual(calls.navigate, []);
});

test('a link followed after the user moved on does nothing', async () => {
  let release;
  const { c, ws, calls } = following({ exists: () => new Promise(r => { release = r; }) });
  const pending = c.fileWsFollowLink(ws, 'x.md');
  vm.runInContext('fileWs = null', c);
  release({ found: { '/home/u/repo/docs/x.md': { path: '/home/u/repo/docs/x.md', kind: 'file' } } });
  await pending;
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.errors, []);
});

test('the editor host hears the bundle event and reads the modifier from the capture-phase click', () => {
  const listeners = {};
  const host = { addEventListener: (type, fn, capture) => { listeners[type + (capture ? ':capture' : '')] = fn; } };
  const followed = [];
  const c = workspace({ $: id => (id === 'docEditor' ? host : null) });
  vm.runInContext('fileWsFollowLink = (ws, target, opts) => followed.push([target, opts.system])', Object.assign(c, { followed }));
  const ws = {};
  c.fileWsWireDocLinks(ws);
  const linkTarget = { closest: sel => (sel === '.cm-file-link' ? {} : null) };
  listeners['click:capture']({ ctrlKey: false, target: linkTarget });
  listeners['file-link-navigate']({ detail: { path: 'a.md' } });
  listeners['click:capture']({ ctrlKey: true, target: linkTarget });
  listeners['file-link-navigate']({ detail: { path: 'b.md' } });
  listeners['click:capture']({ metaKey: true, target: { closest: () => null } }); // modifier held, but not on a link
  listeners['file-link-navigate']({ detail: { path: 'c.md' } });
  assert.deepEqual(plain(followed), [['a.md', false], ['b.md', true], ['c.md', false]]);
});
