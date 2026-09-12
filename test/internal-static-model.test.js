'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { runInternalModel } = require('../internal-model');
const { image } = require('./fixtures/memory-fixture.cjs');
test('uncatalogued static models.json provider needs no extension; exact bad IDs fail without network fallback', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-model-')), requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'exact-vision', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.end(chunk({ role: 'assistant', content: 'Synthetic response.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { 'static-fixture': {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', apiKey: 'synthetic-not-a-credential',
    models: [{ id: 'exact-vision', name: 'Fixture', input: ['text', 'image'], reasoning: false, contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const settings = { provider: 'static-fixture', model: 'exact-vision', memoryImages: true, providerExtensions: {} };
  const input = { text: 'Inspect this synthetic source.', images: [image()] };
  const result = await runInternalModel(input, 'Describe.', { agentDir: root, settings });
  assert.equal(result.model, settings.model); assert.equal(requests.length, 1); assert.equal(requests[0].model, 'exact-vision');
  const blocks = requests[0].messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
  assert.equal(blocks.find(b => b.type === 'image_url').image_url.url, 'data:image/png;base64,' + input.images[0].data);
  await assert.rejects(runInternalModel(input, 'Describe.', { agentDir: root, settings: { ...settings, model: 'bad-id' } }), /not resolved exactly/);
  assert.equal(requests.length, 1);
});
