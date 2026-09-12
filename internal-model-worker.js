'use strict';

// Private IPC worker: provider registration + exactly one model request.
// No AgentSession, agent loop, tool executor, session hooks or warm runtime.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LIMITS } = require('./memory-images');
let prepared, invoked = false;
const send = value => new Promise((resolve, reject) => process.send(value, e => e ? reject(e) : resolve()));
async function prepare(request) {
  const sdk = await import(pathToFileURL(path.join(request.packageDir, 'dist/index.js')).href);
  if (!sdk.ModelRuntime?.create || !sdk.DefaultResourceLoader || !sdk.SettingsManager?.inMemory) {
    throw new Error('Installed Pi lacks the model-only helper SDK contract; no fallback');
  }
  const loader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: request.agentDir,
    settingsManager: sdk.SettingsManager.inMemory({}), additionalExtensionPaths: request.extensions,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error('Explicit provider extension failed: ' + loaded.errors.map(e => e.error).join('; '));
  // Silently ignoring session/input/payload hooks could change provider
  // semantics. This worker accepts provider-registration-only extensions.
  for (const extension of loaded.extensions) {
    if (extension.handlers.size) throw new Error('Model-only memory does not support extension lifecycle/input/payload hooks: ' + extension.path);
  }
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(request.agentDir, 'auth.json'),
    modelsPath: path.join(request.agentDir, 'models.json'), modelsStorePath: path.join(request.agentDir, 'models-store.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  if (!Array.isArray(loaded.runtime.pendingProviderRegistrations) || !Array.isArray(loaded.runtime.pendingNativeProviderRegistrations)) {
    throw new Error('Installed Pi lacks explicit provider registration queues; no fallback');
  }
  for (const { name, config } of loaded.runtime.pendingProviderRegistrations) {
    if (name === request.settings.provider) runtime.registerProvider(name, config);
  }
  for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations) {
    if (provider.id === request.settings.provider) runtime.registerNativeProvider(provider);
  }
  if (runtime.getError()) throw new Error('Selected provider configuration is invalid: ' + runtime.getError());
  const model = runtime.getModel(request.settings.provider, request.settings.model);
  if (!model || model.provider !== request.settings.provider || model.id !== request.settings.model) {
    throw new Error('Selected internal model was not resolved exactly; configure a static model definition, no fallback allowed');
  }
  if ((request.settings.memoryImages || request.input.images.length) && !model.input?.includes('image')) throw new Error('Selected internal model does not declare image input');
  const cost = Math.ceil(Buffer.byteLength(request.input.text + request.prompt) / 2) + request.input.images.length * LIMITS.imageTokens + 8000;
  if (!Number.isFinite(model.contextWindow) || cost > Math.min(model.contextWindow, request.settings.contextTokens) * 0.8) {
    throw new Error('Internal input exceeds the selected model admission budget');
  }
  prepared = { request, runtime, model, extensionRuntime: loaded.runtime };
  await send({ type: 'ready' });
}
async function invoke() {
  if (!prepared || invoked) throw new Error('Invalid or duplicate internal model invocation');
  invoked = true;
  const { request, runtime, model } = prepared;
  const context = { systemPrompt: 'Analyze supplied evidence only. Do not execute actions or request tools.', tools: [],
    messages: [{ role: 'user', timestamp: Date.now(), content: [
      { type: 'text', text: request.prompt + '\n\nSOURCE INPUT:\n' + request.input.text }, ...request.input.images,
    ] }] };
  const stream = runtime.streamSimple(model, context, { reasoning: request.settings.thinking === 'off' ? undefined : request.settings.thinking,
    maxRetries: 0, timeoutMs: request.timeoutMs, signal: AbortSignal.timeout(request.timeoutMs) });
  for await (const event of stream) if (event.type === 'text_delta') await send({ type: 'chunk', text: event.delta });
  const message = await stream.result();
  if (message.provider !== model.provider || message.model !== model.id || message.stopReason !== 'stop' ||
      !Array.isArray(message.content) || message.content.some(c => c.type === 'toolCall')) {
    throw new Error(message.errorMessage || 'Internal model returned an incomplete response or tool request; no continuation');
  }
  await send({ type: 'result', message });
}
if (require.main === module) {
  let preparing = false;
  process.on('message', packet => {
    (async () => {
      if (packet.type === 'prepare' && !preparing) { preparing = true; await prepare(packet); }
      else if (packet.type === 'invoke') await invoke();
      else throw new Error('Invalid internal model protocol');
    })().catch(async e => { try { await send({ type: 'error', error: e.message }); } finally { process.exit(1); } });
  });
  process.on('disconnect', () => process.exit(1));
}
