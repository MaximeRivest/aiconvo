'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PricingCatalog, UsageIndex, aggregateFacts, calculateCost, classifyBilling,
  normalizeUsage, parseUsageFile,
} = require('../usageanalytics.js');

test('normalizes Pi and Claude token classes without double counting reasoning', () => {
  assert.deepEqual(normalizeUsage({
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, reasoning: 7,
    totalTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  }, 'pi'), {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5,
    reasoning: 7, totalTokens: 100,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
  assert.equal(normalizeUsage({
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
  }, 'claude').totalTokens, 100);
});

test('Pi cost calculation applies tiers and one-hour cache writes', () => {
  const cost = calculateCost({
    input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
    tiers: [{ inputTokensAbove: 100, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
  }, { input: 50, output: 10, cacheRead: 20, cacheWrite: 40, cacheWrite1h: 10 });
  assert.equal(cost.input, 0.0005);
  assert.equal(cost.output, 0.00045);
  assert.equal(cost.cacheRead, 0.00002);
  assert.equal(cost.cacheWrite, 0.000575);
  assert.equal(cost.total, 0.001545);
});

test('billing rules override safe provider and credential inferences', () => {
  const fact = { provider: 'anthropic', source: 'pi', estimatedCost: 1 };
  assert.equal(classifyBilling(fact, { providerModes: {} }, { anthropic: 'oauth' }).mode, 'subscription');
  assert.equal(classifyBilling(fact, { providerModes: { anthropic: 'api' } }, { anthropic: 'oauth' }).mode, 'api');
  assert.equal(classifyBilling({ provider: 'openrouter', source: 'pi', estimatedCost: 1 }, { providerModes: {} }, { openrouter: 'oauth' }).mode, 'api');
});

test('parses assistant, compaction, and Claude sidechain usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconvo-usage-'));
  const piFile = path.join(dir, 'pi.jsonl');
  fs.writeFileSync(piFile, [
    { type: 'model_change', id: 'm', timestamp: '2026-01-01T00:00:00Z', provider: 'openai', modelId: 'gpt-x' },
    { type: 'message', id: 'a', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.25 } } } },
    { type: 'compaction', id: 'c', timestamp: '2026-01-01T00:00:02Z', usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
  ].map(JSON.stringify).join('\n'));
  const facts = await parseUsageFile(piFile, { source: 'pi' }, new PricingCatalog());
  assert.deepEqual(facts.map(f => f.category), ['assistant', 'compaction']);
  assert.equal(facts[0].totalTokens, 15);
  assert.equal(facts[1].model, 'gpt-x');

  const claudeFile = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(claudeFile, JSON.stringify({
    type: 'assistant', uuid: 'x', isSidechain: true, timestamp: '2026-01-02T00:00:00Z',
    message: { model: 'claude-x', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 } },
  }));
  const claude = await parseUsageFile(claudeFile, { source: 'claude' }, new PricingCatalog());
  assert.equal(claude[0].category, 'subagent');
  assert.equal(claude[0].totalTokens, 9);
});

test('SQLite index deduplicates copied fork entries and aggregates by project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconvo-usage-db-'));
  const transcript = path.join(dir, 'one.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'message', id: 'shared', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: {
      input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.5 },
    } },
  }));
  const idx = new UsageIndex(path.join(dir, 'usage.db'));
  const entry = { source: 'pi', mtimeMs: fs.statSync(transcript).mtimeMs, size: fs.statSync(transcript).size, project: 'Alpha' };
  await idx.updateFile('pi:a', entry, transcript, new PricingCatalog());
  await idx.updateFile('pi:b', entry, transcript, new PricingCatalog());
  const facts = idx.facts(0, Date.now());
  assert.equal(facts.length, 1);
  const data = aggregateFacts(facts, { billing: { providerModes: { openai: 'api' } }, fromMs: 0, toMs: Date.now() });
  assert.equal(data.summary.calls, 1);
  assert.equal(data.summary.tokens, 170);
  assert.equal(data.summary.apiCost, 0.5);
  assert.equal(data.projects[0].project, 'Alpha');
});
