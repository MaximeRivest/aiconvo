'use strict';

const os = require('os');

const DEFAULT_CONTEXT_TOKENS = 272000;

// One semantic namespace per user: the GPU index never mixes two installs.
function defaultSemanticNs() {
  try { return String(os.userInfo().username || '').trim() || 'default'; }
  catch { return 'default'; }
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_SETTINGS = {
  usePiDefault: false,
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
};

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

function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
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
  if (src.usePiDefault === true) {
    return { usePiDefault: true, provider: '', model: '', thinking, contextTokens, semanticSearch, semanticUrl, semanticNs, piEngine, piTheme };
  }
  return {
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
  };
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
    // claude-code is a local Pi extension. --no-extensions still allows explicit -e.
    if (s.provider === 'claude-code' && options.claudeCodeExtension) {
      args.push('-e', options.claudeCodeExtension);
    }
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
  THINKING_LEVELS,
  hasClaudeCodeCredential,
  parseTokenCount,
  formatTokenCount,
  usageContextTokens,
  parseListModels,
  findModel,
  normalizeSettings,
  buildPiArgs,
  modelLabel,
  resolveContextTokens,
  applyResolvedContext,
};
