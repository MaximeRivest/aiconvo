'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sessionCachePath } = require('../cachepaths');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + 2);
}
function cachePathFor(key) {
  return vm.runInNewContext(extract('cachePathFor') + '\ncachePathFor(key)', {
    SESS_DIR: '/cache/sessions', key, sessionCachePath,
  });
}
test('short keys retain existing cache paths', () => {
  assert.equal(cachePathFor('pi:project/session.jsonl'), '/cache/sessions/pi__project__session.jsonl.json');
});
for (const segment of ['a'.repeat(250), '界'.repeat(90)]) {
  test(`long ${segment[0]} key is stable, distinct, bounded and writable atomically`, async t => {
    const key = 'pi:' + segment + '/session.jsonl';
    const name = path.basename(cachePathFor(key));
    assert.match(name, /^sha256-[a-f0-9]{64}\.json$/);
    assert.equal(name, path.basename(cachePathFor(key)));
    assert.notEqual(name, path.basename(cachePathFor(key + 'other')));
    assert.ok(Buffer.byteLength(name + '.tmp-1234567-1234567890-abcdef') < 255);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aiconvo-cache-test-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const write = vm.runInNewContext(extract('writeFileAtomic') + '\nwriteFileAtomic', {
      fsp: fs.promises, process, atomicWriteSeq: 0,
    });
    const dest = path.join(dir, name);
    await write(dest, JSON.stringify({ key }));
    assert.equal(JSON.parse(await fs.promises.readFile(dest, 'utf8')).key, key);
    assert.deepEqual(await fs.promises.readdir(dir), [name]);
  });
}
for (const present of [true, false]) {
  test(`unchanged transcript is ${present ? 'reused' : 'reindexed'} when resolved cache is ${present ? 'present' : 'absent'}`, async () => {
    let indexed = 0;
    const scan = vm.runInNewContext(extract('fullScan') + '\nfullScan', {
      SOURCES: { pi: '/fixture' },
      async *walk() { yield 'session.jsonl'; },
      isMainTranscript: () => true, path,
      fsp: { stat: async () => ({ mtimeMs: 1, size: 2 }) },
      index: { 'pi:session.jsonl': { v: 14, mtimeMs: 1, size: 2 } }, CACHE_VERSION: 14,
      cachePathFor, fs: { existsSync: () => present },
      indexFile: async () => { indexed++; },
      dropIndexed: () => assert.fail('source still exists'),
      console: { log() {} }, scheduleTimelineTitles() {},
    });
    await scan();
    assert.equal(indexed, present ? 0 : 1);
  });
}
