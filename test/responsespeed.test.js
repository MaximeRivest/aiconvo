'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeedMeter, charsPerSecond, calibrationOf, MIN_RATE_MS, MIN_RATE_CHARS } = require('../responsespeed.js');

const assistant = (extra = {}) => ({ role: 'assistant', provider: 'acme', model: 'fast-1', timestamp: 1700000000000, stopReason: 'stop',
  usage: { output: 100 }, content: [], ...extra });
const update = (type, contentIndex, delta) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex, delta } });
const chunk = n => 'x'.repeat(n);

function meterAt(level = null) {
  let clock = 0;
  const meter = createSpeedMeter({ now: () => clock, thinkingLevel: () => level });
  return { meter, at: t => { clock = t; return t; } };
}

test('the rate window opens at the first text delta and excludes hidden reasoning before it', () => {
  const { meter, at } = meterAt('high');
  at(0); meter.observe({ type: 'turn_start' });
  at(10); meter.observe({ type: 'message_end', message: { role: 'user', content: 'hi' } });
  at(1500); meter.observe({ type: 'message_start', message: assistant() });
  // The provider thinks in private for four seconds: no deltas at all.
  at(5500); meter.observe(update('text_delta', 0, chunk(40)));
  at(6500); meter.observe(update('text_delta', 0, chunk(100)));
  at(7500); meter.observe(update('text_delta', 0, chunk(100)));
  const sample = meter.observe({ type: 'message_end', message: assistant({ content: [{ type: 'text', text: chunk(240) }], usage: { output: 60, reasoning: 20 } }) });
  assert.equal(sample.waitMs, 5500, 'the wait runs from turn start to the first text');
  assert.equal(sample.startMs, 1500);
  assert.deepEqual(sample.text, { chars: 240, timedChars: 200, ms: 2000, chunks: 3 });
  assert.equal(charsPerSecond(sample.text), 100, 'only the chars that arrived inside the window are divided by it');
  assert.deepEqual(sample.usage, { output: 60, reasoning: 20 });
  assert.equal(sample.thinkingLevel, 'high');
  assert.equal(sample.messageTimestamp, 1700000000000);
});

test('thinking interleaved between text parts is on neither text clock', () => {
  const { meter, at } = meterAt();
  at(0); meter.observe({ type: 'turn_start' });
  at(100); meter.observe({ type: 'message_start', message: assistant() });
  at(200); meter.observe(update('thinking_delta', 0, chunk(10)));
  at(700); meter.observe(update('thinking_delta', 0, chunk(10)));
  at(1000); meter.observe(update('text_delta', 1, chunk(10)));
  at(2000); meter.observe(update('text_delta', 1, chunk(100)));
  meter.observe({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: chunk(110) } });
  at(3000); meter.observe(update('thinking_delta', 2, chunk(10)));
  at(9000); meter.observe(update('thinking_delta', 2, chunk(10)));
  at(9100); meter.observe(update('text_delta', 3, chunk(10)));
  at(10100); meter.observe(update('text_delta', 3, chunk(100)));
  const sample = meter.observe({ type: 'message_end', message: assistant() });
  assert.deepEqual(sample.text, { chars: 220, timedChars: 200, ms: 2000, chunks: 4 });
  assert.deepEqual(sample.thinking, { chars: 40, timedChars: 20, ms: 6500, chunks: 4 });
  assert.equal(sample.waitMs, 1000);
});

test('a reply delivered in one piece counts its characters but has no timed window', () => {
  const { meter, at } = meterAt();
  at(0); meter.observe({ type: 'turn_start' });
  at(50); meter.observe({ type: 'message_start', message: assistant() });
  const message = assistant({ content: [{ type: 'text', text: chunk(500) }, { type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'ls' } }] });
  const sample = meter.observe({ type: 'message_end', message });
  assert.deepEqual(sample.text, { chars: 500, timedChars: 0, ms: 0, chunks: 0 });
  assert.equal(sample.tool.chars, JSON.stringify({ command: 'ls' }).length);
  assert.equal(sample.waitMs, null, 'no delta ever arrived, so there is no first-text moment');
  assert.equal(charsPerSecond(sample.text), null);
});

test('tool-call argument streaming is measured apart from the answer text', () => {
  const { meter, at } = meterAt();
  at(0); meter.observe({ type: 'turn_start' });
  at(10); meter.observe({ type: 'message_start', message: assistant() });
  at(100); meter.observe(update('toolcall_delta', 0, '{"command":'));
  at(1200); meter.observe(update('toolcall_delta', 0, '"' + chunk(300) + '"}'));
  meter.observe({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 't', name: 'bash', arguments: { command: chunk(300) } } } });
  const sample = meter.observe({ type: 'message_end', message: assistant({ stopReason: 'toolUse' }) });
  assert.equal(sample.text.chars, 0);
  assert.equal(sample.tool.chunks, 2);
  assert.equal(sample.tool.timedChars, 303);
  assert.equal(sample.tool.ms, 1100);
  assert.equal(sample.tool.chars, JSON.stringify({ command: chunk(300) }).length, 'the end event carries the exact arguments');
});

test('an assistant message with nothing streamed yields no sample', () => {
  const { meter, at } = meterAt();
  at(0); meter.observe({ type: 'turn_start' });
  at(5); meter.observe({ type: 'message_start', message: assistant() });
  assert.equal(meter.observe({ type: 'message_end', message: assistant({ stopReason: 'error', errorMessage: 'boom' }) }), null);
  assert.equal(meter.observe({ type: 'message_end', message: { role: 'user', content: 'x' } }), null);
});

test('the live view times an open part up to now and closes at the last chunk once finished', () => {
  const { meter, at } = meterAt();
  at(0); meter.observe({ type: 'turn_start' });
  assert.equal(meter.live(), null);
  at(100); meter.observe({ type: 'message_start', message: assistant() });
  at(200); meter.observe(update('text_delta', 0, chunk(10)));
  at(1200); meter.observe(update('text_delta', 0, chunk(300)));
  at(3200);
  const live = meter.live();
  assert.equal(live.text.ms, 3000, 'a stall shows up as a lengthening window');
  assert.equal(live.text.timedChars, 300);
  assert.equal(live.waitMs, 200);
  const sample = meter.observe({ type: 'message_end', message: assistant() });
  assert.equal(sample.text.ms, 1000);
  assert.equal(meter.live(), null);
});

test('rates need a minimum window and a minimum of timed characters', () => {
  assert.equal(charsPerSecond({ ms: MIN_RATE_MS - 1, timedChars: 10000 }), null);
  assert.equal(charsPerSecond({ ms: 10000, timedChars: MIN_RATE_CHARS - 1 }), null);
  assert.equal(charsPerSecond({ ms: 2000, timedChars: 400 }), 200);
});

test('calibration only uses replies whose hidden share is known', () => {
  const base = { stopReason: 'stop', text: { chars: 400 }, thinking: { chars: 0 }, tool: { chars: 0 }, thinkingLevel: 'high' };
  assert.equal(calibrationOf({ ...base, usage: { output: 100, reasoning: null } }), null, 'thinking on, split unknown');
  assert.equal(calibrationOf({ ...base, usage: { output: 150, reasoning: 50 } }), 4, 'reported split');
  assert.equal(calibrationOf({ ...base, thinkingLevel: 'off', usage: { output: 100, reasoning: null } }), null, 'off does not prove that the provider did no reasoning');
  assert.equal(calibrationOf({ ...base, thinkingLevel: 'off', thinking: { chars: 20 }, usage: { output: 100, reasoning: null } }), null, 'thinking chars while off: not trusted');
  assert.equal(calibrationOf({ ...base, stopReason: 'aborted', usage: { output: 100, reasoning: 0 } }), null, 'partial usage');
  assert.equal(calibrationOf({ ...base, usage: { output: 0, reasoning: 0 } }), null);
  assert.equal(calibrationOf({ ...base, thinking: { chars: 50 }, usage: { output: 150, reasoning: 50 } }), null, 'a thinking summary has no reliable allocation');
  assert.equal(calibrationOf({ ...base, tool: { chars: 50 }, usage: { output: 150, reasoning: 50 } }), null, 'tool framing has no reliable allocation');
});

test('rates are independent of wall-clock changes and text_end delays', () => {
  let wall = 10000;
  const meter = createSpeedMeter({ wallNow: () => wall });
  meter.observe({ type: 'turn_start' }, 0);
  meter.observe({ type: 'message_start', message: assistant() }, 5);
  meter.observe(update('text_delta', 0, chunk(20)), 100);
  wall -= 5000;
  meter.observe(update('text_delta', 0, chunk(300)), 2100);
  meter.observe({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: chunk(320) } }, 3000);
  const sample = meter.observe({ type: 'message_end', message: assistant() }, 10000);
  assert.equal(sample.at, 5000);
  assert.equal(sample.text.ms, 2000);
  assert.equal(charsPerSecond(sample.text), 150);
});

test('Unicode characters are counted once even when a surrogate pair crosses chunks', () => {
  const meter = createSpeedMeter();
  meter.observe({ type: 'message_start', message: assistant() }, 0);
  meter.observe(update('text_delta', 0, '\uD83D'), 1);
  meter.observe(update('text_delta', 0, '\uDE00' + '文'.repeat(200)), 1001);
  const sample = meter.observe({ type: 'message_end', message: assistant({ content: [{ type: 'text', text: '😀' + '文'.repeat(200) }] }) }, 1002);
  assert.equal(sample.text.chars, 201);
  assert.equal(sample.text.timedChars, 200);
  assert.equal(charsPerSecond(sample.text), 200);
});

test('closed text parts do not accumulate later thinking time in the live rate', () => {
  const meter = createSpeedMeter();
  meter.observe({ type: 'message_start', message: assistant() }, 0);
  meter.observe(update('text_delta', 0, chunk(10)), 100);
  meter.observe(update('text_delta', 0, chunk(200)), 1100);
  meter.observe({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 1 } }, 1200);
  meter.observe(update('thinking_delta', 1, chunk(500)), 5000);
  assert.equal(meter.live(5000).text.ms, 1000);
});

test('nonfinite and too-small spans never emit a rate', () => {
  for (const part of [{}, { ms: NaN, timedChars: 500 }, { ms: 2000, timedChars: Infinity }, { ms: 0, timedChars: 500 }]) {
    assert.equal(charsPerSecond(part), null);
  }
});
