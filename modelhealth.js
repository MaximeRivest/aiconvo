'use strict';

const MINUTE = 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_BASE_COOLDOWN_MS = 10 * MINUTE;
const DEFAULT_MAX_COOLDOWN_MS = 30 * MINUTE;

class ModelCallsPausedError extends Error {
  constructor(retryAt, message) {
    const at = Number(retryAt) || Date.now();
    super(message || `automatic memory-model calls are paused until ${new Date(at).toISOString()}`);
    this.name = 'ModelCallsPausedError';
    this.code = 'MODEL_CALLS_PAUSED';
    this.retryAt = at;
  }
}

function cleanInitialState(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const leaves = {};
  for (const [key, item] of Object.entries(raw.leafRetries || {})) {
    if (!item || typeof item !== 'object') continue;
    leaves[key] = {
      failures: Math.max(0, Number(item.failures) || 0),
      nextRetryAt: Math.max(0, Number(item.nextRetryAt) || 0),
      lastError: String(item.lastError || '').slice(0, 1000),
    };
  }
  return {
    identity: String(raw.identity || ''),
    consecutiveFailures: Math.max(0, Number(raw.consecutiveFailures) || 0),
    openUntil: Math.max(0, Number(raw.openUntil) || 0),
    openedAt: Math.max(0, Number(raw.openedAt) || 0),
    openCount: Math.max(0, Number(raw.openCount) || 0),
    recoveredAt: Math.max(0, Number(raw.recoveredAt) || 0),
    lastError: String(raw.lastError || '').slice(0, 1000),
    leafRetries: leaves,
  };
}

function createModelHealth(options = {}) {
  const now = options.now || Date.now;
  const failureThreshold = Math.max(1, Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD);
  const baseCooldownMs = Math.max(1, Number(options.baseCooldownMs) || DEFAULT_BASE_COOLDOWN_MS);
  const maxCooldownMs = Math.max(baseCooldownMs, Number(options.maxCooldownMs) || DEFAULT_MAX_COOLDOWN_MS);
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const state = cleanInitialState(options.initialState);
  let probeInFlight = false;
  let manualProbeOpenedAt = 0;

  function snapshot() {
    const time = now();
    const mode = !state.openUntil ? 'closed' : state.openUntil > time ? 'open' : 'half-open';
    return {
      ...state,
      leafRetries: { ...state.leafRetries },
      mode,
      probeInFlight,
      nextAutomaticAt: state.openUntil || 0,
    };
  }

  function changed() { onChange(snapshot()); }

  function pausedError() {
    return new ModelCallsPausedError(Math.max(state.openUntil || 0, now() + 1000));
  }

  // Closed circuits accept all work. An open circuit blocks automatic work.
  // One explicit user call can probe during a pause. After the pause, exactly
  // one automatic or manual call becomes the half-open probe.
  function begin({ automatic = false } = {}) {
    const time = now();
    if (!state.openUntil) return { probe: false, startedAt: time };

    if (state.openUntil > time) {
      if (automatic || probeInFlight || manualProbeOpenedAt === state.openedAt) throw pausedError();
      probeInFlight = true;
      manualProbeOpenedAt = state.openedAt;
      changed();
      return { probe: true, manual: true, startedAt: time };
    }

    if (probeInFlight) throw pausedError();
    probeInFlight = true;
    changed();
    return { probe: true, manual: !automatic, startedAt: time };
  }

  function success(permit) {
    if (permit && permit.probe) probeInFlight = false;
    const hadFailures = state.consecutiveFailures > 0;
    const wasOpen = state.openUntil > 0;
    state.consecutiveFailures = 0;
    state.lastError = '';
    if (wasOpen) {
      state.openUntil = 0;
      state.openedAt = 0;
      state.openCount = 0;
      state.recoveredAt = now();
      manualProbeOpenedAt = 0;
    }
    if (hadFailures || wasOpen || (permit && permit.probe)) changed();
  }

  function failure(permit, error) {
    if (permit && permit.probe) probeInFlight = false;
    const time = now();
    const alreadyOpen = state.openUntil > time && !(permit && permit.probe);
    state.consecutiveFailures++;
    state.lastError = String(error && error.message || error || 'model call failed').slice(0, 1000);
    if (!alreadyOpen && ((permit && permit.probe) || state.consecutiveFailures >= failureThreshold)) {
      state.openCount = Math.max(1, state.openCount + 1);
      const delay = Math.min(maxCooldownMs, baseCooldownMs * (2 ** (state.openCount - 1)));
      state.openedAt = time;
      state.openUntil = time + delay;
      state.recoveredAt = 0;
      // A failed explicit probe already spent this pause's user override.
      // Do not let a large manual batch turn into immediate repeated probes.
      manualProbeOpenedAt = permit && permit.manual ? state.openedAt : 0;
    }
    changed();
  }

  function setIdentity(value) {
    const identity = String(value || 'default');
    if (state.identity === identity) return false;
    const hadState = !!state.identity;
    const wasOpen = state.openUntil > 0;
    state.identity = identity;
    // Failures and leaf delays belong to the model that caused them. A newly
    // selected model gets a clean health check instead of inheriting a pause.
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.openedAt = 0;
    state.openCount = 0;
    state.lastError = '';
    state.leafRetries = {};
    probeInFlight = false;
    manualProbeOpenedAt = 0;
    if (hadState && wasOpen) state.recoveredAt = now();
    changed();
    return true;
  }

  function isAutomaticPaused() {
    return state.openUntil > now();
  }

  function automaticWaitMs() {
    return Math.max(0, state.openUntil - now());
  }

  function canRunLeaf(key, { automatic = true } = {}) {
    if (!automatic) return true;
    const retry = state.leafRetries[key];
    return !retry || retry.nextRetryAt <= now();
  }

  function leafFailure(key, error) {
    const old = state.leafRetries[key] || { failures: 0 };
    const failures = old.failures + 1;
    const delay = Math.min(maxCooldownMs, baseCooldownMs * (2 ** (failures - 1)));
    const retry = {
      failures,
      nextRetryAt: now() + delay,
      lastError: String(error && error.message || error || 'leaf extraction failed').slice(0, 1000),
    };
    state.leafRetries[key] = retry;
    changed();
    return { ...retry };
  }

  function deferLeaf(key, retryAt, error) {
    const old = state.leafRetries[key] || { failures: 0, nextRetryAt: 0, lastError: '' };
    state.leafRetries[key] = {
      failures: old.failures,
      nextRetryAt: Math.max(old.nextRetryAt || 0, Number(retryAt) || now() + baseCooldownMs),
      lastError: String(error && error.message || error || old.lastError || 'model calls paused').slice(0, 1000),
    };
    changed();
    return { ...state.leafRetries[key] };
  }

  function leafSuccess(key) {
    if (!state.leafRetries[key]) return;
    delete state.leafRetries[key];
    changed();
  }

  function dueLeafKeys() {
    const time = now();
    return Object.entries(state.leafRetries)
      .filter(([, item]) => item.nextRetryAt <= time)
      .map(([key]) => key);
  }

  return {
    begin, success, failure, snapshot, setIdentity,
    isAutomaticPaused, automaticWaitMs,
    canRunLeaf, leafFailure, deferLeaf, leafSuccess, dueLeafKeys,
  };
}

module.exports = {
  createModelHealth,
  ModelCallsPausedError,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_BASE_COOLDOWN_MS,
  DEFAULT_MAX_COOLDOWN_MS,
};
