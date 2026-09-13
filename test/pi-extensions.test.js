'use strict';
// Regression tests for piExtensions:'minimal' — web sessions may opt out of
// the user's full agent-dir extension stack.
//
// Scenarios covered:
// 1. settings normalization: 'all' default, 'minimal' parses, garbage falls
//    back to 'all', and the value survives both return paths.
// 2. argument construction: terminal launches NEVER get --no-extensions;
//    web launches get it (plus the explicit -e set incl. modes.ts) only in
//    minimal mode and stay identical to terminals in 'all' mode.
// 3. parseExtraArgs (pisdk-runtime): --no-extensions / -ne set the dedicated
//    field and do not leak into the extension-flag map.
const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(root, 'pisdk-runtime.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `${name} body not terminated`);
  return src.slice(start, end + 2);
}

describe('Scenario: piExtensions setting normalizes safely', () => {
  const settings = require(path.join(root, 'settings.js'));
  it('given no explicit value, when normalized, then it is all (upstream default unchanged)', () => {
    assert.equal(settings.normalizeSettings({}).piExtensions, 'all');
    assert.equal(settings.DEFAULT_SETTINGS.piExtensions, 'all');
  });
  it("given 'minimal', when normalized, then it survives both return paths", () => {
    assert.equal(settings.normalizeSettings({ piExtensions: 'minimal' }).piExtensions, 'minimal');
    assert.equal(settings.normalizeSettings({ usePiDefault: true, piExtensions: 'minimal' }).piExtensions, 'minimal');
  });
  it('given an unknown value, when normalized, then it falls back to all', () => {
    assert.equal(settings.normalizeSettings({ piExtensions: 'none' }).piExtensions, 'all');
  });
});

describe('Scenario: minimal mode scopes to web sessions only', () => {
  const makeFns = appSettings => {
    const stubs = {
      fs: { existsSync: () => true },
      path: { join: (...a) => a.join('/') },
      CLAUDE_CODE_EXT: '/ext/claude-code.ts',
    };
    const src = extractFunction(serverSrc, 'piProviderExtraArgs') + '\n' + extractFunction(serverSrc, 'piWebExtraArgs');
    return new Function('fs', 'path', 'CLAUDE_CODE_EXT', 'appSettings', '__dirname',
      src + '\nreturn { piProviderExtraArgs, piWebExtraArgs };')(
      stubs.fs, stubs.path, stubs.CLAUDE_CODE_EXT, appSettings, '/repo');
  };

  it('given any setting, when a terminal launch is prepared, then the args never contain --no-extensions', () => {
    for (const piExtensions of ['all', 'minimal']) {
      const fns = makeFns({ piExtensions });
      const args = fns.piProviderExtraArgs();
      assert.ok(!args.includes('--no-extensions'), piExtensions);
      assert.deepEqual(args.filter(a => a === '-e').length, 3); // claude bridge, delegation, records
    }
  });

  it("given 'all', when a web session is prepared, then its args equal the terminal set", () => {
    const fns = makeFns({ piExtensions: 'all' });
    assert.deepEqual(fns.piWebExtraArgs(), fns.piProviderExtraArgs());
  });

  it("given 'minimal', when a web session is prepared, then it is --no-extensions plus the explicit set including modes.ts", () => {
    const fns = makeFns({ piExtensions: 'minimal' });
    const args = fns.piWebExtraArgs();
    assert.equal(args[0], '--no-extensions');
    const paths = args.filter((a, i) => args[i - 1] === '-e');
    assert.equal(paths.length, 4);
    assert.ok(paths.includes('/ext/claude-code.ts'), 'provider bridge rides along');
    assert.deepEqual(paths.filter(p => p.startsWith('/repo/extensions/')).sort(),
      ['/repo/extensions/delegation.ts', '/repo/extensions/modes.ts', '/repo/extensions/records.ts']);
    assert.ok(paths.some(p => p.endsWith('modes.ts')), 'modes.ts must ride along: --prompt-mode is an extension flag');
  });
});

describe('Scenario: parseExtraArgs recognizes the discovery switch', () => {
  const parse = extraArgs => new Function(extractFunction(runtimeSrc, 'parseExtraArgs') + '\nreturn parseExtraArgs(arguments[0]);')(extraArgs);
  it('given --no-extensions or -ne, when parsed, then noExtensions is set and the flag map stays clean', () => {
    for (const form of [['--no-extensions', '-e', '/a.ts'], ['-ne'], ['--no-extensions']]) {
      const out = parse(form);
      assert.equal(out.noExtensions, true, form.join(' '));
      assert.equal(out.flags.size, 0, form.join(' '));
      assert.deepEqual(out.extensionPaths, form.includes('-e') ? ['/a.ts'] : []);
    }
  });
  it('given an ordinary extension flag, when parsed, then it still lands in the flag map untouched', () => {
    const out = parse(['--some-flag', 'yes']);
    assert.equal(out.noExtensions, false);
    assert.equal(out.flags.get('some-flag'), 'yes');
  });
});

// F8 follow-up: pin the actual SDK wiring (resourceLoaderOptions.noExtensions
// + additionalExtensionPaths), not just the argument parsing. Skipped where
// the pi executable (and with it the embedded SDK) is unavailable.
const { execFileSync } = require('node:child_process');
let piAvailable = false;
try { piAvailable = !!execFileSync('which', ['pi'], { encoding: 'utf8' }).trim(); } catch {}

test('real SDK: minimal wiring loads only the explicit extension set', {
  skip: !piAvailable && 'Pi executable is unavailable; SDK wiring is not validated',
  timeout: 60000,
}, async () => {
  process.env.AICONVO_NO_AUTO_MODELS = '1';
  const runtime = require(path.join(root, 'pisdk-runtime.js'));
  const { SDK } = await runtime.loadSdk();
  const agentDir = SDK.getAgentDir();
  const extra = ['extensions/delegation.ts', 'extensions/records.ts', 'extensions/modes.ts'].map(f => path.join(root, f));
  const settingsManager = SDK.SettingsManager.create(root, agentDir, { projectTrusted: false });
  const services = await SDK.createAgentSessionServices({
    cwd: root, agentDir, settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(15000),
    resourceLoaderOptions: { additionalExtensionPaths: extra, noExtensions: true },
  });
  const loaded = services.resourceLoader.getExtensions().extensions.map(e => path.basename(e.path || ''));
  assert.ok(loaded.length <= extra.length + 1, `unexpected extra extensions loaded: ${loaded.join(', ')}`);
  for (const want of ['delegation.ts', 'records.ts', 'modes.ts'])
    assert.ok(loaded.includes(want), `${want} missing from: ${loaded.join(', ')}`);
});
