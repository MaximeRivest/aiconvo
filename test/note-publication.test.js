'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { publishNote } = require('../note-publication');
for (const phase of ['mkdir', 'write', 'guard']) test('title revocation during ' + phase + ' restores source heading and deterministic filename at actual replacement', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let allowed = true;
  const result = await publishNote({ note: '# Source\n\n## Detail\nGrounded content.', sourceTitle: 'Source', title: 'Generated', abstract: 'Useful abstract.',
    aiTitles: () => allowed, target: title => path.join(root, (title || 'Source') + '.md'),
    mkdir: async dir => { await fs.mkdir(dir, { recursive: true }); if (phase === 'mkdir') allowed = false; },
    write: async (file, text) => { await fs.writeFile(file, text); if (phase === 'write') allowed = false; },
    guard: () => { if (phase === 'guard') allowed = false; } });
  assert.equal(result.title, 'Source'); assert.equal(result.file, path.join(root, 'Source.md'));
  const text = await fs.readFile(result.file, 'utf8'); assert.match(text, /^# Source\n/); assert.match(text, /Useful abstract/); assert.ok(!text.includes('Generated'));
  assert.deepEqual(await fs.readdir(root), ['Source.md']);
});
