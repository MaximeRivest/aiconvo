'use strict';
// Streaming speed of assistant replies, measured from what actually arrived:
// characters and the moments they arrived. Nothing here trusts a provider's
// token counter for timing. Providers count hidden reasoning inside `output`
// and only some report the split, so `output ÷ seconds` would silently
// reward a model for thinking in private. The clock of every content part
// opens at its first delta and closes at its last: a silent stretch before
// the text lengthens the wait, never the rate, and thinking interleaved
// between two text parts is not on either part's clock.
//
// The first chunk of a part is counted but not timed. Its characters arrived
// during the interval before the clock opened, which nobody observed; with
// N chunks the span covers N−1 arrivals, and those are the chars the rate
// divides. A provider that delivers a part in one lump (no streaming) gives
// chars with zero timed chars and zero milliseconds: a fact, not a speed.
//
// Two processes use this: the Pi runtime (source-stamped, persisted into
// the session) and the server's run forwarder (the live readout while a
// reply streams). Same code, same numbers.

const { performance } = require('node:perf_hooks');

// Count Unicode code points, not UTF-16 code units. A surrogate pair may
// itself be split across transport chunks; delta() corrects that boundary.
function characterCount(text) {
  let count = 0;
  for (const _char of text) count++;
  return count;
}

function blankPart() {
  return { chars: 0, timedChars: 0, ms: 0, chunks: 0 };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// One assistant message in flight: its parts by content index.
class MessageMeter {
  constructor({ anchorAt, startedAt, thinkingLevel }) {
    this.anchorAt = anchorAt;
    this.startedAt = startedAt;
    this.thinkingLevel = thinkingLevel == null ? null : String(thinkingLevel);
    this.parts = new Map(); // contentIndex → { kind, chars, leadChars, chunks, firstAt, lastAt }
    this.firstTextAt = null;
  }

  part(index, kind) {
    let p = this.parts.get(index);
    if (!p) { p = { kind, chars: 0, leadChars: 0, chunks: 0, firstAt: null, lastAt: null, closed: false }; this.parts.set(index, p); }
    p.kind = kind;
    return p;
  }

  delta(index, kind, text, at) {
    if (typeof text !== 'string' || !text.length) return;
    const p = this.part(index, kind);
    let len = characterCount(text);
    if (p.highSurrogate && /^[\uDC00-\uDFFF]/.test(text)) len--;
    p.highSurrogate = /[\uD800-\uDBFF]$/.test(text);
    if (p.firstAt == null) { p.firstAt = at; p.leadChars = len; }
    p.lastAt = at;
    p.chars += len;
    p.chunks++;
    if (kind === 'text' && this.firstTextAt == null) this.firstTextAt = at;
  }

  // The end of a part carries its whole content. Characters that never
  // came as deltas (a provider that does not stream this kind) are counted
  // as lead: present, untimed.
  reconcile(index, kind, length) {
    const p = this.part(index, kind);
    if (length > p.chars) { p.leadChars += length - p.chars; p.chars = length; }
    p.closed = true;
  }

  observe(ev, at) {
    if (/_start$/.test(ev.type)) {
      for (const [index, p] of this.parts) if (index !== ev.contentIndex) p.closed = true;
    }
    switch (ev.type) {
      case 'text_delta': this.delta(ev.contentIndex, 'text', ev.delta, at); break;
      case 'thinking_delta': this.delta(ev.contentIndex, 'thinking', ev.delta, at); break;
      case 'toolcall_delta': this.delta(ev.contentIndex, 'tool', ev.delta, at); break;
      case 'text_end': if (typeof ev.content === 'string') this.reconcile(ev.contentIndex, 'text', characterCount(ev.content)); break;
      case 'thinking_end': if (typeof ev.content === 'string') this.reconcile(ev.contentIndex, 'thinking', characterCount(ev.content)); break;
      case 'toolcall_end': if (ev.toolCall) this.reconcile(ev.contentIndex, 'tool', argumentsLength(ev.toolCall.arguments)); break;
      default: break;
    }
  }

  // Totals per kind so far. With `at`, a part still open is timed up to that
  // moment, so the live readout shows a stall as the falling rate it is.
  // The finished sample closes every part at its last chunk instead.
  totals(at = null) {
    const out = { text: blankPart(), thinking: blankPart(), tool: blankPart() };
    for (const p of this.parts.values()) {
      const t = out[p.kind];
      if (!t) continue;
      t.chars += p.chars;
      t.timedChars += p.chars - p.leadChars;
      t.chunks += p.chunks;
      if (p.firstAt == null) continue;
      const until = at != null && !p.closed ? Math.max(at, p.lastAt) : p.lastAt;
      t.ms += Math.max(0, until - p.firstAt);
    }
    return out;
  }

  finish(message, at) {
    const content = Array.isArray(message && message.content) ? message.content : [];
    // A reply that arrived without any update events (some providers answer
    // in one piece) still has its content in the final message.
    content.forEach((block, index) => {
      if (!block) return;
      if (block.type === 'text' && typeof block.text === 'string') this.reconcile(index, 'text', characterCount(block.text));
      else if (block.type === 'thinking' && typeof block.thinking === 'string') this.reconcile(index, 'thinking', characterCount(block.thinking));
      else if (block.type === 'toolCall') this.reconcile(index, 'tool', argumentsLength(block.arguments));
    });
    const totals = this.totals();
    const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : {};
    const textOnly = content.length > 0 && content.every(b => b?.type === 'text' && typeof b.text === 'string')
      && content.reduce((n, b) => n + characterCount(b.text), 0) === totals.text.chars;
    return {
      provider: message && message.provider ? String(message.provider) : null,
      model: message && message.model ? String(message.model) : null,
      stopReason: message && message.stopReason ? String(message.stopReason) : null,
      thinkingLevel: this.thinkingLevel,
      messageTimestamp: message && typeof message.timestamp === 'number' ? message.timestamp : null,
      // From turn_start to the first visible answer text. Includes context
      // preparation: this is an observed wait, not provider-only latency.
      // Hidden reasoning, network and provider queueing all live in here.
      waitMs: this.firstTextAt != null && this.anchorAt != null ? Math.max(0, this.firstTextAt - this.anchorAt) : null,
      // Same origin to the provider's first response event.
      startMs: this.startedAt != null && this.anchorAt != null ? Math.max(0, this.startedAt - this.anchorAt) : null,
      text: totals.text, thinking: totals.thinking, tool: totals.tool,
      usage: {
        output: number(usage.output),
        reasoning: textOnly && Number.isFinite(usage.reasoning) && usage.reasoning >= 0 ? usage.reasoning : null,
      },
    };
  }
}

function argumentsLength(args) {
  if (args == null) return 0;
  if (typeof args === 'string') return characterCount(args);
  try { return characterCount(JSON.stringify(args)); } catch { return 0; }
}

// A sample with nothing streamed carries no information about speed.
function sampleHasContent(sample) {
  return !!sample && (sample.text.chars + sample.thinking.chars + sample.tool.chars) > 0;
}

// Consumes a session's event stream and yields one sample per assistant
// message. `now` is injectable for tests; production passes the moment the
// event was handed over.
function createSpeedMeter(options = {}) {
  const now = options.now || (() => performance.now());
  const wallNow = options.wallNow || Date.now;
  const thinkingLevelOf = options.thinkingLevel || (() => null);
  let anchorAt = null;
  let current = null;
  return {
    // Returns the finished sample on an assistant message_end, else null.
    observe(event, at = now()) {
      if (!event || typeof event !== 'object') return null;
      const role = event.message && event.message.role;
      switch (event.type) {
        case 'agent_start':
          anchorAt = null;
          current = null;
          return null;
        case 'turn_start':
          anchorAt = at;
          return null;
        case 'message_start':
          if (role === 'assistant') current = new MessageMeter({ anchorAt, startedAt: at, message: event.message, thinkingLevel: thinkingLevelOf() });
          return null;
        case 'message_update':
          if (current && event.assistantMessageEvent) current.observe(event.assistantMessageEvent, at);
          return null;
        case 'message_end':
          if (role === 'assistant') {
            const meter = current || new MessageMeter({ anchorAt, startedAt: at, message: event.message, thinkingLevel: thinkingLevelOf() });
            current = null;
            const sample = { ...meter.finish(event.message, at), at: wallNow() };
            return sampleHasContent(sample) ? sample : null;
          }
          return null;
        case 'agent_end':
          current = null;
          return null;
        default:
          return null;
      }
    },
    // The reply in flight, or null between replies.
    live(at = now()) {
      if (!current) return null;
      const totals = current.totals(at);
      return { text: totals.text, thinking: totals.thinking, tool: totals.tool,
        waitMs: current.firstTextAt != null && current.anchorAt != null ? current.firstTextAt - current.anchorAt : null };
    },
  };
}

// ---- rates -----------------------------------------------------------------

// Below these, a measurement says more about chunk timing than about the
// model: the span error is about one chunk interval, and a two-line reply
// is a few dozen tokens. Such samples still count characters (calibration)
// but not speed.
const MIN_RATE_MS = 1000;
const MIN_RATE_CHARS = 200;
// Without a per-model calibration, tokens are estimated at this many
// characters each: fair for English prose, a stretch for dense code or
// non-Latin scripts. All token readouts remain marked as estimates.
const DEFAULT_CHARS_PER_TOKEN = 4;

function charsPerSecond(part, { minMs = MIN_RATE_MS, minChars = MIN_RATE_CHARS } = {}) {
  if (!part || !Number.isFinite(part.ms) || !Number.isFinite(part.timedChars)
    || part.ms <= 0 || part.ms < minMs || part.timedChars < minChars) return null;
  return part.timedChars * 1000 / part.ms;
}

// Only text-only replies with an explicit reasoning split are comparable.
// A requested thinking level of 'off' is not proof the provider obeyed it.
// Thinking summaries and tool framing do not have an unambiguous token
// allocation; never calibrate from them. Even calibrated rates are estimates
// because character/token ratios change with language and content.
function calibrationOf(sample) {
  const output = sample.usage?.output;
  const reasoning = sample.usage?.reasoning;
  if (!Number.isFinite(output) || !Number.isFinite(reasoning) || reasoning < 0 || output <= reasoning
    || !['stop', 'length'].includes(sample.stopReason)
    || sample.thinking.chars || sample.tool.chars || sample.text.chars < MIN_RATE_CHARS) return null;
  return sample.text.chars / (output - reasoning);
}

module.exports = {
  MIN_RATE_MS, MIN_RATE_CHARS, DEFAULT_CHARS_PER_TOKEN,
  createSpeedMeter, charsPerSecond, calibrationOf, sampleHasContent,
};
