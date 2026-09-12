// Synthetic, network-free provider. Only use in an isolated test HOME.
import fs from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function (pi: any) {
  if (process.env.MEMORY_FIXTURE_HOOK === '1') pi.on('before_agent_start', async () => undefined);
  pi.registerTool({ name: 'fixture_forbidden', label: 'Forbidden test tool', description: 'Must never be active',
    parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('A model-only call executed a tool'); } });
  pi.registerProvider('memory-fixture', {
    api: 'openai-completions', apiKey: 'synthetic-not-a-credential', baseUrl: 'http://127.0.0.1:1/never-used',
    models: ['vision', 'text'].map(id => ({ id, name: id, reasoning: false, input: id === 'vision' ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2000 })),
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (!process.env.MEMORY_FIXTURE_CAPTURE) throw new Error('A private capture file is required');
        fs.appendFileSync(process.env.MEMORY_FIXTURE_CAPTURE, JSON.stringify({ provider: model.provider, model: model.id,
          content: context.messages.at(-1)?.content, tools: context.tools || [], systemPrompt: context.systemPrompt,
          maxRetries: options?.maxRetries, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() }) + '\n');
        const fail = process.env.MEMORY_FIXTURE_FAIL === '1';
        const input = context.messages.at(-1)?.content.find((c: any) => c.type === 'text')?.text || '';
        let output: any = { note: 'Synthetic grounded note.', abstract: 'Synthetic abstract.', intent: [], environment: [], problems: [] };
        if (input.includes('"overview":{"summary"')) output = { overview: { summary: 'Fixture overview.' }, epicCandidates: [] };
        else if (input.includes('"tiers":[')) {
          const rows = input.split('\n').flatMap((line: string) => { try { const q = JSON.parse(line); return q.id ? [q] : []; } catch { return []; } });
          output = { tiers: rows.map((q: any) => ({ id: q.id, tier: 'standing', note: 'Fixture weight.' })) };
        } else if (input.includes('"changes":[')) output = { changes: [] };
        else if (input.includes('"coreIntent"')) output = { coreIntent: 'Fixture direction.' };
        else if (input.includes('"recentFocus"')) output = { recentFocus: [], unfinished: [], todos: [], openQuestions: [] };
        else if (input.includes('"setup":[')) output = { summary: 'Fixture environment.', setup: [] };
        const result = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: JSON.stringify(output) }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: fail ? 'error' : 'stop', errorMessage: fail ? 'context_length_exceeded: synthetic failure' : undefined, timestamp: Date.now() };
        if (process.env.MEMORY_FIXTURE_TOOL === '1') {
          result.stopReason = 'toolUse';
          result.content = [{ type: 'toolCall', id: 'unexpected', name: 'fixture_forbidden', arguments: {} }] as any;
        }
        stream.push(fail ? { type: 'error', reason: 'error', error: result } : { type: 'done', reason: 'stop', message: result }); stream.end();
      });
      return stream;
    },
  });
}
