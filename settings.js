'use strict';

const os = require('os');
const path = require('path');
const AUTOMATIC_MEMORY_MODES = ['legacy', 'off', 'changes-after-enable'];

const DEFAULT_CONTEXT_TOKENS = 272000;

// One semantic namespace per user: the GPU index never mixes two installs.
function defaultSemanticNs() {
  try { return String(os.userInfo().username || '').trim() || 'default'; }
  catch { return 'default'; }
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// What the speakers do when a web run finishes with a reply. One ordered
// ladder, quietest first:
//   off     — nothing
//   chime   — one short sound, no speech, no network
//   title   — one spoken line naming the conversation that returned
//   summary — that line plus a short spoken digest of the reply
//   voice   — the digest, then the microphone opens for a reply or command
const DONE_SOUND_MODES = ['off', 'chime', 'title', 'summary', 'voice'];
const DEFAULT_SETTINGS = {
  usePiDefault: false,
  providerExtensions: {},
  aiTitles: true,
  memoryImages: false,
  automaticMemory: 'legacy',
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  thinking: 'off',
  contextTokens: DEFAULT_CONTEXT_TOKENS,
  // Optional GPU-server late-interaction search stage (off by default).
  semanticSearch: false,
  semanticUrl: 'http://192.168.2.24:8090',
  semanticNs: defaultSemanticNs(),
  // Engine for web sends: 'sdk' embeds pi in-process (fast forks, full
  // extension UI); 'rpc' spawns pi child processes (isolation fallback).
  piEngine: 'sdk',
  // pi theme for hosted extension views (custom TUI components rendered
  // in the browser). 'light' matches aiconvo's paper look.
  piTheme: 'light',
  // Typed in the composer, this opens the snippet picker inline. Two
  // semicolons: almost never in prose or code, and one key on most layouts.
  snippetTrigger: ';;',
  doneSound: 'voice',
  // Cost analytics keeps billing classification separate from Pi's retail
  // cost estimate. Rules are provider-scoped and never contain credentials.
  usageBilling: { providerModes: {}, monthlyFees: {} },
  // Other aiconvo installs reachable from the header machine switcher.
  // Each entry: { name, url, token }. The token is that machine's LAN token.
  machines: [],
};

// Keep only well-formed machine entries: a name, an http(s) URL without a
// trailing slash, and a token string (may be empty for a local-only URL).
function normalizeMachines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const url = String(m.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) continue;
    const name = String(m.name || '').trim().slice(0, 40) || url.replace(/^https?:\/\//i, '');
    const token = String(m.token || '').trim();
    const id = url.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name, url, token });
  }
  return out;
}

function parseTokenCount(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (s.endsWith('M')) return Math.round(n * 1_000_000);
  if (s.endsWith('K')) return Math.round(n * 1_000);
  return Math.round(n);
}

function formatTokenCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000 && v % 1_000_000 === 0) return (v / 1_000_000) + 'M';
  if (v >= 1_000 && v % 1_000 === 0) return (v / 1_000) + 'K';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// The context footprint a reply leaves behind: the tokens the NEXT turn
// carries. This is the provider's own counter, not a text estimate.
// pi normalizes usage as { input, output, cacheRead, cacheWrite, ... };
// claude transcripts use { input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens }. In both formats
// the cache fields are NOT included in the plain input field, so a meter
// that ignores them reads far too low.
function usageContextTokens(usage, kind) {
  const u = usage || {};
  if (kind === 'claude') {
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
}

function parseListModels(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0];
  const names = ['provider', 'model', 'context', 'max-out', 'thinking', 'images'];
  const starts = names.map(name => header.indexOf(name));
  const useCols = starts.every((v, i) => v >= 0 && (i === 0 || v > starts[i - 1]));
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let provider, model, contextLabel, maxOutLabel, thinking, images;
    if (useCols) {
      const slice = (a, b) => line.slice(a, b).trim();
      provider = slice(starts[0], starts[1]);
      model = slice(starts[1], starts[2]);
      contextLabel = slice(starts[2], starts[3]);
      maxOutLabel = slice(starts[3], starts[4]);
      thinking = slice(starts[4], starts[5]);
      images = line.slice(starts[5]).trim();
    } else {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      [provider, model, contextLabel, maxOutLabel, thinking, images] = parts;
    }
    if (!provider || !model || provider === 'provider') continue;
    out.push({
      provider,
      model,
      id: provider + '/' + model,
      context: parseTokenCount(contextLabel),
      contextLabel,
      maxOut: parseTokenCount(maxOutLabel),
      thinking: thinking === 'yes',
      images: images === 'yes',
    });
  }
  return out;
}

function findModel(models, provider, model) {
  const list = Array.isArray(models) ? models : [];
  const p = String(provider || '');
  const m = String(model || '');
  if (!m) return null;
  return list.find(item => item.provider === p && item.model === m)
    || list.find(item => item.id === m || item.model === m)
    || null;
}

function normalizeUsageBilling(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(['api', 'subscription', 'free', 'local', 'unknown']);
  const providerModes = {};
  for (const [provider, mode] of Object.entries(src.providerModes || {})) {
    const key = String(provider).trim();
    if (key && allowed.has(mode)) providerModes[key] = mode;
  }
  const monthlyFees = {};
  for (const [provider, value] of Object.entries(src.monthlyFees || {})) {
    const key = String(provider).trim();
    const fee = Number(value);
    if (key && Number.isFinite(fee) && fee > 0) monthlyFees[key] = Math.round(fee * 100) / 100;
  }
  return { providerModes, monthlyFees };
}

function normalizeProviderExtensions(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('providerExtensions must be an object');
  const out = {};
  for (const [provider, value] of Object.entries(raw)) {
    const paths = typeof value === 'string' ? [value] : value;
    if (!provider.trim() || !Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
      throw new Error('Provider extensions must be explicit absolute trusted file paths');
    }
    Object.defineProperty(out, provider, { value: [...new Set(paths)], enumerable: true });
  }
  return out;
}

function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (src.automaticMemory !== undefined && !AUTOMATIC_MEMORY_MODES.includes(src.automaticMemory)) throw new Error('Invalid automaticMemory policy');
  for (const key of ['aiTitles', 'memoryImages']) if (src[key] !== undefined && typeof src[key] !== 'boolean') throw new Error(key + ' must be a boolean');
  const memory = {
    providerExtensions: normalizeProviderExtensions(src.providerExtensions),
    aiTitles: src.aiTitles !== false,
    memoryImages: src.memoryImages === true,
    automaticMemory: AUTOMATIC_MEMORY_MODES.includes(src.automaticMemory) ? src.automaticMemory : 'legacy',
  };
  const thinking = THINKING_LEVELS.includes(src.thinking) ? src.thinking : DEFAULT_SETTINGS.thinking;
  const provider = String(src.provider || '').trim();
  const model = String(src.model || '').trim();
  const contextTokens = Number(src.contextTokens) > 0
    ? Math.round(Number(src.contextTokens))
    : DEFAULT_SETTINGS.contextTokens;
  const semanticSearch = src.semanticSearch === true;
  const semanticUrl = String(src.semanticUrl || DEFAULT_SETTINGS.semanticUrl).trim().replace(/\/$/, '');
  const semanticNs = String(src.semanticNs || DEFAULT_SETTINGS.semanticNs).trim().replace(/[^\w.-]+/g, '-') || 'default';
  const piEngine = src.piEngine === 'rpc' ? 'rpc' : 'sdk';
  const piTheme = typeof src.piTheme === 'string' && src.piTheme.trim() ? src.piTheme.trim() : DEFAULT_SETTINGS.piTheme;
  const usageBilling = normalizeUsageBilling(src.usageBilling);
  const snippetTrigger = normalizeSnippetTrigger(src.snippetTrigger);
  const doneSound = DONE_SOUND_MODES.includes(src.doneSound) ? src.doneSound : DEFAULT_SETTINGS.doneSound;
  const machines = normalizeMachines(src.machines);
  if (src.usePiDefault === true) {
    return { ...memory, usePiDefault: true, provider: '', model: '', thinking, contextTokens, semanticSearch, semanticUrl, semanticNs, piEngine, piTheme, usageBilling, snippetTrigger, doneSound, machines };
  }
  return {
    ...memory,
    usePiDefault: false,
    provider: provider || DEFAULT_SETTINGS.provider,
    model: model || DEFAULT_SETTINGS.model,
    thinking,
    contextTokens,
    semanticSearch,
    semanticUrl,
    semanticNs,
    piEngine,
    piTheme,
    usageBilling,
    snippetTrigger,
    doneSound,
    machines,
  };
}

// 1–4 visible characters; never a bare / or @, which already own the
// composer's other palettes.
function normalizeSnippetTrigger(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || t.length > 4 || /\s/.test(t) || t === '/' || t === '@') return DEFAULT_SETTINGS.snippetTrigger;
  return t;
}

function hasClaudeCodeCredential(data) {
  return !!(data && data.claudeAiOauth && typeof data.claudeAiOauth === 'object');
}

function buildPiArgs(settings, options = {}) {
  const s = normalizeSettings(settings);
  const args = [
    '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files',
    '--thinking', s.thinking,
  ];
  if (!s.usePiDefault) {
    if (s.provider) args.push('--provider', s.provider);
    if (s.model) args.push('--model', s.model);
    // --no-extensions remains set: only the selected provider's trusted
    // entrypoints are allowed. Preserve the legacy claude-code default.
    const selected = s.providerExtensions[s.provider] ||
      (s.provider === 'claude-code' && options.claudeCodeExtension ? [options.claudeCodeExtension] : []);
    for (const entrypoint of selected) args.push('-e', entrypoint);
  }
  return args;
}

function modelLabel(settings, piDefault) {
  const s = normalizeSettings(settings);
  if (s.usePiDefault) {
    if (piDefault && (piDefault.provider || piDefault.model)) {
      return 'pi default (' + [piDefault.provider, piDefault.model].filter(Boolean).join('/') + ')';
    }
    return 'pi default';
  }
  return s.provider ? s.provider + '/' + s.model : s.model;
}

function resolveContextTokens(settings, models, piDefault) {
  const s = normalizeSettings(settings);
  if (s.usePiDefault) {
    const hit = findModel(models, piDefault && piDefault.provider, piDefault && piDefault.model);
    if (hit && hit.context) return hit.context;
  } else {
    const hit = findModel(models, s.provider, s.model);
    if (hit && hit.context) return hit.context;
  }
  return s.contextTokens || DEFAULT_CONTEXT_TOKENS;
}

function applyResolvedContext(settings, models, piDefault) {
  const s = normalizeSettings(settings);
  s.contextTokens = resolveContextTokens(s, models, piDefault);
  return s;
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_SETTINGS,
  AUTOMATIC_MEMORY_MODES,
  normalizeProviderExtensions,
  THINKING_LEVELS,
  DONE_SOUND_MODES,
  hasClaudeCodeCredential,
  parseTokenCount,
  formatTokenCount,
  usageContextTokens,
  parseListModels,
  findModel,
  normalizeUsageBilling,
  normalizeMachines,
  normalizeSettings,
  buildPiArgs,
  modelLabel,
  resolveContextTokens,
  applyResolvedContext,
};
