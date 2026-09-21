'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

const app = fs.readFileSync(require.resolve('../app.html'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('const MODEL_POWER_TIERS ='), app.indexOf('// Floating model picker.')), context);
const row = (model, provider = 'fixture') => ({ model, provider, id: provider + '/' + model });
const sorted = names => Array.from(context.sortedPickerModels({ models: names.map(m => row(m)) }), m => m.model);
function expectOrder(names) { assert.deepEqual(sorted([...names].reverse()), names); }

test('generations descend numerically, then the requested named tiers', () => {
  expectOrder(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna', 'gpt-5.10-astra', 'gpt-5.9-astra']);
  expectOrder(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-opus-4-8', 'claude-haiku-4-5']);
  expectOrder(['gemini-3.1-flash-lite', 'gemini-3-ultra', 'gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite', 'gemini-2.5-ultra']);
  expectOrder(['gpt-6-astra-pro', 'gpt-6-astra', 'gpt-6-sol-pro', 'gpt-6-sol']);
});

test('Grok versions descend under xAI and OpenRouter, with aliases last', () => {
  for (const [provider, prefix] of [['xai', ''], ['openrouter', 'x-ai/']]) {
    const names = ['grok-4.6', 'grok-4.5', 'grok-4.3'].map(m => prefix + m);
    const result = context.sortedPickerModels({ models: [...names].reverse().map(m => row(m, provider)), readyProviders: [provider] });
    assert.deepEqual(Array.from(result, m => m.model), names);
  }
  expectOrder(['x-ai/grok-4.6', 'x-ai/grok-4.6:batch', 'x-ai/grok-4.5', 'x-ai/grok-4.3', '~x-ai/grok-latest']);
  expectOrder(['grok-4.10', 'grok-4.9', 'grok-4.6', 'grok-3']);
});

test('Claude version spellings, old tier placement, and snapshots', () => {
  expectOrder(['claude-opus-4.6', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20260920', 'claude-3-5-sonnet', 'claude-3-haiku']);
  const a = context.modelOrderKey('claude-fable-5-1'), b = context.modelOrderKey('claude-fable-5.1');
  assert.equal(context.compareModelOrderKeys(a, b), 0);
});

test('router namespaces and special editions stay with their base model', () => {
  expectOrder(['anthropic/claude-fable-5.1', 'anthropic/claude-fable-5.1:batch', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5:batch', '~anthropic/claude-fable-latest', '~anthropic/claude-opus-latest']);
  expectOrder(['google/gemini-3-pro', 'google/gemini-3-pro:batch', 'google/gemini-3-pro:free', 'google/gemini-3-flash']);
  expectOrder(['gpt-6-astra', 'gpt-6-astra-2026-09-01', 'gpt-6-astra-2026-08-01', 'gpt-5.9-astra-2026-09-20']);
});

test('common numeric families understand decimal and p versions, not size or context', () => {
  expectOrder(['accounts/fireworks/models/deepseek-v4p1-flash', 'accounts/fireworks/models/deepseek-v4-pro', 'accounts/fireworks/models/deepseek-v4-flash']);
  expectOrder(['qwen3p10-max', 'qwen3.9-27b', 'qwen3.8-235b']);
  expectOrder(['kimi-k3', 'kimi-k2.7-code', 'kimi-k2-0905-preview']);
  expectOrder(['glm-5p3', 'glm-5p2']);
  expectOrder(['k3-256k', 'k2-512k']);
  assert.deepEqual(Array.from(context.modelOrderKey('gpt-oss-120b').version), []);
});

test('providers remain contiguous, signed-in first; families are not ranked against each other', () => {
  const models = [row('gpt-6-astra', 'openrouter'), row('claude-fable-5', 'openrouter'), row('claude-fable-5', 'anthropic'), row('gpt-5.6', 'openai-codex'), row('claude-fable-5.1', 'openrouter')];
  const before = JSON.stringify(models);
  const result = context.sortedPickerModels({ models, readyProviders: ['openrouter', 'openai-codex'] });
  assert.deepEqual(Array.from(result, m => m.id), ['openai-codex/gpt-5.6', 'openrouter/claude-fable-5.1', 'openrouter/claude-fable-5', 'openrouter/gpt-6-astra', 'anthropic/claude-fable-5']);
  assert.equal(JSON.stringify(models), before, 'catalog must not be mutated');
  assert.ok(result.every(m => models.includes(m)), 'preserve row metadata');
});

test('unknown names stay visible and deterministic without invented tier ranks', () => {
  expectOrder(['gpt-6-astra', 'gpt-6-mystery', 'gpt-5.6-sol', 'gpt-latest', 'mystery-2', 'mystery-10']);
  assert.equal(context.modelOrderKey('gemini-3-flashlight').tier[2], 100, 'do not partially match flash');
  assert.deepEqual(Array.from(context.sortedPickerModels({})), []);
  const keys = ['gpt-6-astra', 'claude-fable-5', 'gemini-3-pro', 'gemini-3-flash-lite', 'claude-opus-4-5-20251101', 'gpt-latest', 'mystery'].map(context.modelOrderKey);
  for (const a of keys) for (const b of keys) {
    const ab = context.compareModelOrderKeys(a, b), ba = context.compareModelOrderKeys(b, a);
    assert.ok(Math.sign(ab) === -Math.sign(ba));
    for (const c of keys) if (ab <= 0 && context.compareModelOrderKeys(b, c) <= 0) assert.ok(context.compareModelOrderKeys(a, c) <= 0);
  }
});

test('picker browser: initial order, filtering, refresh and keyboard selection', { timeout: 60000 }, async t => {
  const { evaluate, until, exceptions } = await viewerBrowser(t);
  const catalog = { readyProviders: ['fixture'], models: ['gpt-5.9-astra', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra'].map(m => row(m)) };
  await evaluate(`window.pickerFixture = ${JSON.stringify(catalog)}; modelCatalog = async () => window.pickerFixture; window.pickerPicks = []; openModelPicker(document.querySelector('#settingsBtn'), {}, picks => window.pickerPicks.push(picks))`);
  const visible = `Array.from(document.querySelectorAll('.mpick .mp-row'), el => el.dataset.mp)`;
  assert.deepEqual(await evaluate(visible), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna', 'gpt-5.9-astra'].map(m => 'fixture/' + m));
  await evaluate(`document.querySelector('.mp-filter').value = 'gpt-6'; document.querySelector('.mp-filter').dispatchEvent(new Event('input'))`);
  assert.equal((await evaluate(visible)).length, 4);
  await evaluate(`window.pickerFixture.models.push(${JSON.stringify(row('gpt-7-luna'))}); document.querySelector('.mp-filter').value = ''; document.querySelector('.mp-refresh').click()`);
  await until(`document.querySelector('.mp-row')?.dataset.mp === 'fixture/gpt-7-luna'`);
  await evaluate(`document.querySelector('.mp-filter').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`);
  assert.deepEqual(await evaluate('window.pickerPicks'), [[{ provider: 'fixture', modelId: 'gpt-7-luna' }]]);
  assert.equal(await evaluate(`!!document.querySelector('.mpick')`), false);
  assert.deepEqual(exceptions, []);
});
