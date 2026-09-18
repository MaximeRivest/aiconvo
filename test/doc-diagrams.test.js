'use strict';
// Tests for the document reading view (`setDocDiagrams` and friends in
// app.html): the host-side surface that shows a rendered document with
// mermaid diagrams and switches back to the editor. The functions live
// inside app.html, so their source text is extracted and evaluated with
// small stubs. The real mermaid rendering is covered by
// test/doc-diagrams-browser.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('// ---- document reading view: diagrams ⇄ code');
const end = html.indexOf('// ---- end document reading view');
assert.ok(start > 0 && end > start, 'reading-view source found in app.html');
const source = html.slice(start, end);

const DOC = '# Doc\n\n```mermaid\ngraph LR\n  A --> B\n```\n';

// A fake document pane: the editor host, the preview, and the menu button.
function harness({ text = DOC, preview = true } = {}) {
  const calls = { mdRender: [], mermaid: [], toast: [], measured: false };
  const node = () => {
    const el = { hidden: false, innerHTML: '', focused: false, listeners: [], focus() { this.focused = true; } };
    el.addEventListener = (type, fn) => el.listeners.push([type, fn]);
    return el;
  };
  const previewNode = node();
  previewNode.hidden = true;
  const editorNode = node();
  const button = { textContent: 'Reading view', classes: {}, classList: { toggle: (name, value) => { button.classes[name] = value; } } };
  const nodes = { docEditor: editorNode, docPreview: preview ? previewNode : null, docDiagrams: button };
  const context = vm.createContext({
    docState: {
      path: '/vault/_System/docs/project/flow-views.md',
      editor: { getContent: () => text, view: { requestMeasure: () => { calls.measured = true; } } },
    },
    $: id => nodes[id] ?? null,
    mdRender: (src, q, image) => { calls.mdRender.push({ src, q, image }); return 'RENDERED:' + src.length; },
    renderMermaids: root => { calls.mermaid.push(root); return Promise.resolve(); },
    toast: message => { calls.toast.push(message); },
  });
  vm.runInContext(source, context);
  return { c: context, calls, preview: previewNode, editor: editorNode, button, nodes };
}

test('a mount starts in the editor with the preview hidden', () => {
  const { c, preview, editor, button } = harness();
  assert.equal(c.setDocDiagrams(false), false);
  assert.equal(preview.hidden, true);
  assert.equal(editor.hidden, false);
  assert.equal(button.textContent, 'Reading view');
});

test('toggling on renders the document, shows the preview and hides the editor', () => {
  const { c, calls, preview, editor, button } = harness();
  assert.equal(c.toggleDocDiagrams(), true);
  assert.deepEqual(calls.mdRender.map(r => [r.src, r.q]), [[DOC, '']]);
  assert.equal(calls.mdRender[0].image, c.docDiagramImage, 'the reading view owns image resolution');
  assert.equal(preview.innerHTML, '<div class="md">RENDERED:' + DOC.length + '</div>');
  assert.equal(preview.hidden, false);
  assert.equal(preview.focused, true, 'the preview takes focus so Ctrl+Shift+M works from it');
  assert.equal(editor.hidden, true);
  assert.deepEqual(calls.mermaid, [preview], 'diagrams render in the preview, without waiting for the observer');
  assert.equal(button.textContent, 'Reading view ✓');
  assert.deepEqual(button.classes, { on: true });
  assert.match(calls.toast.at(-1), /reading view/);
});

test('toggling back restores the editor and re-measures it', () => {
  const { c, calls, preview, editor, button } = harness();
  c.toggleDocDiagrams();
  assert.equal(c.toggleDocDiagrams(), false);
  assert.equal(preview.hidden, true);
  assert.equal(preview.innerHTML, '', 'the rendered copy does not linger');
  assert.equal(editor.hidden, false);
  assert.equal(calls.measured, true);
  assert.equal(button.textContent, 'Reading view');
  assert.deepEqual(button.classes, { on: false });
  assert.match(calls.toast.at(-1), /editor/);
});

test('it reads the live editor text, not the disk copy', () => {
  const { c, calls } = harness({ text: '# unsaved draft' });
  c.toggleDocDiagrams();
  assert.equal(calls.mdRender[0].src, '# unsaved draft');
});

test('without a preview host (legacy mount) it stays off instead of throwing', () => {
  const { c, editor, button } = harness({ preview: false });
  assert.equal(c.setDocDiagrams(true), false);
  assert.equal(editor.hidden, false);
  assert.equal(button.textContent, 'Reading view');
});

test('relative image paths resolve through the document asset API', () => {
  const { c } = harness();
  assert.equal(c.docDiagramImage('img/f1.png'),
    '/api/doc/asset?doc=%2Fvault%2F_System%2Fdocs%2Fproject%2Fflow-views.md&src=img%2Ff1.png');
  assert.equal(c.docDiagramImage('./figures/a b.png'),
    '/api/doc/asset?doc=%2Fvault%2F_System%2Fdocs%2Fproject%2Fflow-views.md&src=.%2Ffigures%2Fa%20b.png');
  assert.equal(c.docDiagramImage('https://example.org/x.png'), 'https://example.org/x.png');
  assert.equal(c.docDiagramImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(c.docDiagramImage('/absolute/x.png'), null, 'the app cannot serve a vault-absolute path');
  assert.equal(c.docDiagramImage('#anchor'), null);
  assert.equal(c.docDiagramImage(''), null);
});

test('Ctrl+Shift+M toggles, Ctrl+M and Shift+M alone do not', () => {
  const { c, calls } = harness();
  // `docDiagramsOn` is a script-level binding, not a context property.
  const on = () => vm.runInContext('docDiagramsOn', c);
  const press = (mods, key) => {
    let prevented = false;
    c.docDiagramsKey({ ...mods, key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(press({ ctrlKey: true, shiftKey: true }, 'M'), true);
  assert.equal(on(), true);
  assert.equal(press({ ctrlKey: true }, 'm'), false, 'Ctrl+M alone belongs to the editor');
  assert.equal(press({ shiftKey: true }, 'M'), false);
  assert.equal(press({ metaKey: true, shiftKey: true }, 'M'), true, 'Cmd+Shift+M on a Mac');
  assert.equal(on(), false);
  assert.equal(calls.toast.length, 2, 'only the two real toggles reported');
});
