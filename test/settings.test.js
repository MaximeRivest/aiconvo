// Run: node --test test/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTokenCount, formatTokenCount, parseListModels, findModel,
  normalizeSettings, buildPiArgs, modelLabel, resolveContextTokens, DEFAULT_SETTINGS,
  hasClaudeCodeCredential, usageContextTokens,
} = require('../settings.js');

const TABLE = [
  'provider      model                                                     context  max-out  thinking  images',
  'anthropic     claude-fable-5                                            1M       128K     yes       yes   ',
  'openai-codex  gpt-5.6-sol                                               272K     128K     yes       yes   ',
  'fireworks     accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b  262.1K   262.1K   yes       no    ',
  'xai           grok-4.6                                                  500K     500K     yes       yes   ',
  'openai        gpt-4                                                     8.2K     8.2K     no        no    ',
].join('\n');

test('parseTokenCount reads K and M labels', () => {
  assert.strictEqual(parseTokenCount('1M'), 1_000_000);
  assert.strictEqual(parseTokenCount('1.0M'), 1_000_000);
  assert.strictEqual(parseTokenCount('272K'), 272000);
  assert.strictEqual(parseTokenCount('131.1K'), 131100);
  assert.strictEqual(parseTokenCount('8.2K'), 8200);
  assert.strictEqual(parseTokenCount(''), 0);
});

test('formatTokenCount keeps compact labels', () => {
  assert.strictEqual(formatTokenCount(272000), '272K');
  assert.strictEqual(formatTokenCount(1_000_000), '1M');
  assert.strictEqual(formatTokenCount(8200), '8.2K');
});

test('parseListModels reads the pi table', () => {
  const models = parseListModels(TABLE);
  assert.strictEqual(models.length, 5);
  assert.deepStrictEqual(models[1], {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    id: 'openai-codex/gpt-5.6-sol',
    context: 272000,
    contextLabel: '272K',
    maxOut: 128000,
    thinking: true,
    images: true,
  });
  assert.strictEqual(models[2].model, 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b');
  assert.strictEqual(models[2].context, 262100);
  assert.strictEqual(models[4].thinking, false);
});

test('normalizeSettings keeps the built-in default', () => {
  assert.deepStrictEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.strictEqual(normalizeSettings({ thinking: 'high' }).provider, 'openai-codex');
  assert.strictEqual(normalizeSettings({ thinking: 'nope' }).thinking, 'off');
});

test('normalizeSettings can follow the pi default', () => {
  const s = normalizeSettings({ usePiDefault: true, thinking: 'low' });
  assert.strictEqual(s.usePiDefault, true);
  assert.strictEqual(s.provider, '');
  assert.strictEqual(s.model, '');
  assert.strictEqual(s.thinking, 'low');
});

test('buildPiArgs includes the selected model', () => {
  const args = buildPiArgs({ provider: 'xai', model: 'grok-4.6', thinking: 'high' });
  assert.deepStrictEqual(args.slice(-6), ['--thinking', 'high', '--provider', 'xai', '--model', 'grok-4.6']);
  assert.ok(args.includes('--no-tools'));
});

test('buildPiArgs omits provider flags for the pi default', () => {
  const args = buildPiArgs({ usePiDefault: true, thinking: 'off' });
  assert.ok(!args.includes('--provider'));
  assert.ok(!args.includes('--model'));
  assert.ok(args.includes('--no-tools'));
});

test('buildPiArgs loads the claude-code extension', () => {
  const ext = '/home/maxime/.pi/agent/extensions/claude-code-fable-5/index.ts';
  const args = buildPiArgs({ provider: 'claude-code', model: 'claude-fable-5' }, { claudeCodeExtension: ext });
  assert.deepStrictEqual(args.slice(-6), ['--provider', 'claude-code', '--model', 'claude-fable-5', '-e', ext]);
  assert.ok(args.includes('--no-extensions'));
  const other = buildPiArgs({ provider: 'xai', model: 'grok-4.6' }, { claudeCodeExtension: ext });
  assert.ok(!other.includes('-e'));
});

test('hasClaudeCodeCredential only checks the login object', () => {
  assert.strictEqual(hasClaudeCodeCredential({ claudeAiOauth: { accessToken: 'x' } }), true);
  assert.strictEqual(hasClaudeCodeCredential({}), false);
  assert.strictEqual(hasClaudeCodeCredential(null), false);
});

test('usageContextTokens counts the whole window footprint', () => {
  // pi usage: cache fields sit outside `input`, so they must be added.
  assert.strictEqual(usageContextTokens({
    input: 89127, output: 454, cacheRead: 2560, cacheWrite: 0, reasoning: 140, totalTokens: 92141,
  }, 'pi'), 92141);
  assert.strictEqual(usageContextTokens({ input: 100, output: 50, cacheWrite: 25 }, 'pi'), 175);
  // claude usage: cache reads and cache creation are also in the window.
  assert.strictEqual(usageContextTokens({
    input_tokens: 12, output_tokens: 88, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500,
  }, 'claude'), 40600);
  // Missing fields never throw and count as zero.
  assert.strictEqual(usageContextTokens({}, 'pi'), 0);
  assert.strictEqual(usageContextTokens(null, 'claude'), 0);
});

test('resolveContextTokens uses the catalog when present', () => {
  const models = parseListModels(TABLE);
  assert.strictEqual(resolveContextTokens({ provider: 'xai', model: 'grok-4.6' }, models), 500000);
  assert.strictEqual(resolveContextTokens({ usePiDefault: true }, models, { provider: 'xai', model: 'grok-4.6' }), 500000);
  assert.strictEqual(findModel(models, 'openai-codex', 'gpt-5.6-sol').id, 'openai-codex/gpt-5.6-sol');
  assert.strictEqual(modelLabel({ provider: 'xai', model: 'grok-4.6' }), 'xai/grok-4.6');
  assert.strictEqual(modelLabel({ usePiDefault: true }, { provider: 'xai', model: 'grok-4.6' }), 'pi default (xai/grok-4.6)');
});
