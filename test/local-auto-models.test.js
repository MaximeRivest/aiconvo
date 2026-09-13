'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

// Same bounded VM approach as server-jobs.test.js: no live server/providers.
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
function load(name, context = {}) {
  return vm.runInNewContext(extract(name) + '\n' + name, {
    AUTO_MODELS_DISABLED: true, DOCS_REGEN_DEBOUNCE_MS: 0, ...context,
  });
}

for (const [name, args] of [
  ['maybeAutoProjectTitle', ['project']],
  ['scheduleTimelineTitles', []], ['refreshTimelineTitles', []],
  ['scheduleAutoRetitle', ['session']], ['sweepSettledLeaves', []],
  ['scheduleDocsRegen', ['project']], ['scheduleEpicRegenForKeys', [['session']]],
  ['scheduleDocCommitTitle', ['root', 'hash', 'diff']],
]) {
  test(`${name}: disabled before timers, state access, or jobs`, async () => {
    assert.equal(await load(name)(...args), undefined);
  });
}

test('automatic memory jobs reject before accessing data or creating jobs', () => {
  assert.throws(() => load('startMemoryExtractJob')([], null, { automatic: true }), /Automatic model calls disabled/);
  assert.throws(() => load('startDocsJobCore')('key', 'title', null, null, null, { automatic: true }), /Automatic model calls disabled/);
});

for (const [options, inherited] of [
  [{ automatic: true }, null], [{}, { automatic: true }],
]) {
  test(`runPi blocks automatic calls before any effects: ${JSON.stringify(options)}`, async () => {
    const run = load('runPi', { modelCallContext: { getStore: () => inherited } });
    await assert.rejects(run('private data', 'prompt', null, options), error => {
      assert.equal(error.code, 'AUTO_MODELS_DISABLED');
      assert.equal(error.modelCallFailure, undefined);
      return true;
    });
  });
}

for (const [disabled, options, inherited] of [
  [true, {}, null], [true, { automatic: false }, { automatic: true }],
  [false, { automatic: true }, null],
]) {
  test(`manual calls stay available; unset flag preserves upstream (${disabled}, ${JSON.stringify(options)})`, async () => {
    const effects = [];
    const run = load('runPi', {
      AUTO_MODELS_DISABLED: disabled,
      modelCallContext: { getStore: () => inherited },
      path, os: { tmpdir: () => '/unused-fixture' }, process: { pid: 1 },
      fs: { writeFileSync: () => effects.push('write') },
      fsp: { unlink: async () => effects.push('unlink') },
      memoryModelHealth: {
        setIdentity() {}, begin: ({ automatic }) => ({ automatic }),
        success: () => effects.push('success'), failure: () => assert.fail('unexpected failure'),
      },
      currentModelLabel: () => 'fixture', piArgs: () => [], MODEL_ACTIVITY_TIMEOUT_MS: 1000,
      execFile: () => assert.fail('real spawn forbidden'),
      execFileWithActivityTimeout: async () => { effects.push('mock-launch'); return { stdout: 'fixture response' }; },
    });
    assert.equal(await run('data', 'prompt', null, options), 'fixture response');
    assert.deepEqual(effects, ['write', 'mock-launch', 'success', 'unlink']);
  });
}

test('catalog stays cached unless an explicit refresh is requested', async () => {
  const cache = { models: [] };
  assert.equal(await load('listPiModels', { modelsCache: cache })(), cache);
  let calls = 0;
  const result = await load('listPiModels', {
    modelsCache: cache, modelsPending: null,
    execFileWithFileStdout: (_cmd, _args, _opts, cb) => { calls++; cb(new Error('fixture unavailable'), '', ''); },
  })(true);
  assert.equal(calls, 1);
  assert.match(result.error, /fixture unavailable/);
});

test('implicit project naming and commit titles are classified automatic', () => {
  assert.match(extract('retitleProject'), /PROJECT_RETITLE_PROMPT, null, \{ automatic: !manual \}/);
  assert.match(extract('scheduleDocCommitTitle'), /DOC_COMMIT_TITLE_PROMPT, null, \{ automatic: true \}/);
  assert.match(source, /if \(!AUTO_MODELS_DISABLED\) listPiModels\(\)\.finally/);
});
