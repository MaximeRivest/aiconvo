const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preview, cleanOutput } = require('../streaming-tool');

test('native edit streams readable old/new strings at every boundary', () => {
  const input = { path: 'src/a.py', oldText: 'a\n"quoted"\\end', newText: 'b\n\t😀' };
  const raw = JSON.stringify(input);
  for (let i = 0; i <= raw.length; i++) {
    const p = preview(raw.slice(0, i), '?');
    if (p.path) assert.ok(input.path.startsWith(p.path));
    for (const e of p.edits) {
      if (e.old !== undefined) assert.ok(input.oldText.startsWith(e.old));
      if (e.new !== undefined) assert.ok(input.newText.startsWith(e.new));
    }
  }
  assert.deepEqual(preview(raw, 'edit').edits, [{ old: input.oldText, new: input.newText }]);
});

test('multiple replacements and writes including apparent JSON fields in code', () => {
  assert.deepEqual(preview(JSON.stringify({ path: 'x', edits: [
    { oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' },
  ] }), 'edit').edits, [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }]);
  const content = '"oldText":"not a field"\n<script>alert(1)</script>\n' + 'x'.repeat(10000);
  const p = preview(JSON.stringify({ path: 'x', content }), '?');
  assert.equal(p.kind, 'write');
  assert.equal(p.content, content);
  assert.deepEqual(p.edits, []);
});

test('shell commands decode at every streaming boundary without rewriting shell syntax', () => {
  const command = 'cd project && echo "hello"\npython - <<\'PY\'\nprint("<script>")\nPY';
  const raw = JSON.stringify({ command, timeout: 120 });
  for (let i = 0; i <= raw.length; i++) {
    const p = preview(raw.slice(0, i), '?');
    if (p.command !== undefined) {
      assert.equal(p.kind, 'bash');
      assert.ok(command.startsWith(p.command));
    }
  }
  assert.equal(preview(raw, 'bash').command, command);
  assert.equal(preview(raw, 'other_tool').kind, null);
});

test('shell output removes terminal controls and handles progress lines', () => {
  assert.equal(cleanOutput('\x1b[31mred\x1b[0m\n\x1b[4murl\x1b[0m'), 'red\nurl');
  assert.equal(cleanOutput('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(cleanOutput('10%\r100%\r\nDone\n\x1b[3'), '100%\nDone\n');
  assert.equal(cleanOutput('text\x1b]unfinished'), 'text');
  assert.equal(cleanOutput('<script>\n\ttabs'), '<script>\n\ttabs');
});

test('unfinished unicode and backslash escapes do not leak into code', () => {
  assert.equal(preview('{"content":"hello\\u00', '?').content, 'hello');
  assert.equal(preview('{"content":"hello\\', '?').content, 'hello');
  assert.equal(preview('{"content":"\\ud83d\\ude00"}', '?').content, '😀');
  assert.equal(preview('{"command":"echo hello"}', 'bash').kind, 'bash');
});
