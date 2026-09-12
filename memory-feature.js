'use strict';

const fs = require('node:fs');
const { createAutomation, revision } = require('./memory-automation');
const { sourceSnapshot } = require('./memory-images');
const { createMultimodalMemory, modelIdentity } = require('./multimodal-memory');
const { runInternalModel } = require('./internal-model');

function createMemoryFeature(hooks) {
  const policy = createAutomation({ file: hooks.stateFile });
  let configuring = false;
  const creations = new Map();
  const selected = () => hooks.settings();
  const context = () => hooks.context.getStore();
  const check = () => {
    const c = context();
    c?.check?.();
    if (c?.automatic && !c.ticket && (!legacyAllowed() || c.epoch !== policy.status(selected().automaticMemory).epoch)) {
      throw new Error('Legacy automatic consent changed; no further calls or publication');
    }
  };
  async function model(input, prompt, guard = check, options = {}) {
    const inherited = context();
    const automatic = options.automatic ?? !!inherited?.automatic;
    const epoch = options.epoch ?? inherited?.epoch ?? policy.status(selected().automaticMemory).epoch;
    const authorize = () => {
      check(); guard();
      if (automatic && !inherited?.ticket && (!legacyAllowed() || epoch !== policy.status(selected().automaticMemory).epoch)) {
        throw new Error('Automatic consent changed; no invocation or publication');
      }
    };
    const invoke = async () => {
      authorize();
      const message = await (hooks.runInternalModel || runInternalModel)(input, prompt, { ...options, settings: selected(), check: authorize,
        claudeCodeExtension: hooks.claudeCodeExtension?.() });
      authorize(); hooks.usage?.(message);
      return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    };
    // The existing document builder has parallel lanes. Serialize its model
    // subcalls too, not merely its outer job, under this consent ticket.
    const c = context();
    if (!c?.ticket) return invoke();
    const call = (c.callTail || Promise.resolve()).then(invoke);
    c.callTail = call.catch(() => {});
    return call;
  }
  const builder = createMultimodalMemory({ parseFile: hooks.parseFile, settings: selected, run: model,
    projectOf: data => hooks.projectOf(data.key), check });
  function legacyAllowed() {
    const s = policy.status(selected().automaticMemory);
    return selected().automaticMemory === 'legacy' && !s.epoch && !fs.existsSync(hooks.stateFile) ||
      selected().automaticMemory === 'legacy' && policy.legacyAllowed();
  }
  return {
    model, check,
    // Shared routing seam: callers cannot lose explicit automatic metadata at
    // the transport switch. Image mode does not reroute unrelated text helpers.
    routeCall(input, prompt, options = {}) {
      const c = context(), automatic = options.automatic ?? !!c?.automatic;
      const epoch = options.epoch ?? c?.epoch ?? policy.status(selected().automaticMemory).epoch;
      return { automatic, epoch, modelOnly: !!c?.ticket || !!(selected().memoryImages && (options.memory || c?.memory)),
        invoke: () => model(input, prompt, options.guard, { ...options, automatic, epoch }) };
    },
    epoch: () => policy.status(selected().automaticMemory).epoch,
    build: (data, guard) => builder.build(data, hooks.sourceFile(data.key), guard),
    enabled: () => selected().memoryImages || selected().automaticMemory === 'changes-after-enable',
    fingerprint: rev => revision('attributed-memory-v1\0' + rev + '\0' + modelIdentity(selected())),
    status: () => policy.status(selected().automaticMemory),
    legacyAllowed,
    automaticAllowed() {
      try { check(); return !!context()?.ticket || legacyAllowed(); } catch { return false; }
    },
    created(key, event) {
      const status = policy.status(selected().automaticMemory);
      if (!configuring && status.active && event?.kind === 'watch-create') creations.set(key, { ...event, epoch: status.epoch });
    },
    observe(key, rev) {
      if (configuring || selected().automaticMemory !== 'changes-after-enable') return;
      const snapshot = sourceSnapshot(hooks.sourceFile(key));
      if (snapshot.revision !== rev) return;
      const status = policy.status(selected().automaticMemory);
      const provenance = require('./memory-observation').observation(snapshot, creations.get(key), status.epoch, status.activatedAt);
      policy.observe(key, rev, { provenance }); creations.delete(key);
    },
    async configure(next) {
      if (configuring) throw new Error('Automation configuration is already in progress');
      if (next.automaticMemory === selected().automaticMemory) return;
      configuring = true;
      try {
        if (next.automaticMemory === 'changes-after-enable' && next.usePiDefault) throw new Error('Changes-after-enable requires an explicit internal provider/model');
        const baseline = {};
        if (next.automaticMemory === 'changes-after-enable') {
          for await (const { key, file } of hooks.sources()) baseline[key] = sourceSnapshot(file).revision;
        }
        policy.activate(next.automaticMemory, baseline); creations.clear();
      } finally { configuring = false; }
    },
    discard: key => policy.discard(key),
    async sweep(settleMs) {
      if (configuring || selected().automaticMemory !== 'changes-after-enable') return;
      const key = policy.ready(settleMs).find(k => hooks.canRun(k));
      if (!key) return;
      const ticket = policy.claim(key), settingsHash = modelIdentity(selected()), project = hooks.projectOf(key);
      const guard = () => {
        policy.check(ticket, sourceSnapshot(hooks.sourceFile(key)).revision, selected().automaticMemory);
        if (modelIdentity(selected()) !== settingsHash || hooks.projectOf(key) !== project) throw new Error('Memory configuration or project changed during automatic work');
      };
      hooks.reserve(key, true);
      try {
        await hooks.context.run({ automatic: true, ticket, check: guard }, async () => {
          guard();
          const data = await hooks.data(key);
          if (data.sourceRevision && data.sourceRevision !== ticket.revision) throw new Error('Indexed source revision is stale');
          const built = await builder.build(data, hooks.sourceFile(key));
          guard(); built.guard();
          await hooks.publish(key, data, built);
          guard(); policy.stage(ticket, 'note-and-leaf');
          await hooks.documents(key);
          guard(); policy.stage(ticket, 'documents');
        });
        policy.finish(ticket);
      } catch (e) { policy.finish(ticket, e); hooks.error?.(key, e); }
      finally { hooks.reserve(key, false); hooks.changed?.(); }
    },
  };
}
module.exports = { createMemoryFeature };
