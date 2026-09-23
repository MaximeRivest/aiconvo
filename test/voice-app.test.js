'use strict';
// Voice commands in the app: Alt+L starts listening with the browser's
// microphone (a fake one here), the overlay shows what is heard and what
// is decided, sentences become actions — at once when Jev is sure, as a
// suggestion to confirm when it is not, ignored when they are no command —
// dictation writes into the message box until "stop", and Alt+L stops.
// The server is real; the speech service and Jev are stand-ins that speak
// their real protocols.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('always listening: heard, decided, done, asked, dictated, stopped', { timeout: 90000 }, async t => {
  // The speech stand-in hears "hello there" in the first passes, then
  // nothing: the recording loops, and later sentences are the test's own.
  let passes = 0;
  const speech = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(++passes <= 3 ? 'hello there' : ''); }); });
  // Jev's stand-in: the action named in what was said; sure unless "maybe".
  const jev = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks)), said = body.state.said, q = body.questions;
      const opts = name => Object.keys(q[name].criteria);
      const answer = (choice, confidence = 0.97) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });
      const answers = {};
      if (opts('action').includes('text')) answers.action = answer(/^stop/.test(said) ? 'stop' : /^send$/.test(said) ? 'send' : 'text');
      else {
        const action = /yes/.test(said) ? 'confirm' : /settings/.test(said) ? 'settings' : /conversation/.test(said) ? 'open_conversation' : /microphone/.test(said) ? 'dictate' : 'none';
        answers.action = answer(opts('action').includes(action) ? action : 'none', /maybe/.test(said) ? 0.55 : 0.97);
        if (q['settings.pane']) answers['settings.pane'] = answer(/appearance/.test(said) ? 'appearance' : 'profile');
        if (q['open_conversation.conversation']) answers['open_conversation.conversation'] = answer(opts('open_conversation.conversation')[0]);
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answers }));
    });
  });
  await Promise.all([speech, jev].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { speech.close(); jev.close(); });
  // The microphone plays this, looped: a room's quiet, then 1.5 s of
  // a voice-like tone, then a long pause — a sentence the window hears.
  const rate = 16000, seconds = 4, pcm = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < rate * seconds; i++) {
    const t = i / rate, voiced = t >= 1 && t < 2.5;
    pcm.writeInt16LE(Math.round((voiced ? 6000 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0) + ((i * 7919) % 41) - 20), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  const microphone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mic-')), 'microphone.wav');
  fs.writeFileSync(microphone, Buffer.concat([head, pcm]));
  t.after(() => fs.rmSync(path.dirname(microphone), { recursive: true, force: true }));
  const b = await viewerBrowser(t, {
    setup: home => {
      fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: 'http://127.0.0.1:' + speech.address().port }));
    },
    env: { TYPESAFE_API_KEY: 'test-key-0123456789abcdef', TYPESAFE_URL: 'http://127.0.0.1:' + jev.address().port + '/v1/systemone' },
    flags: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + microphone, '--autoplay-policy=no-user-gesture-required'],
  });
  const { evaluate: ev, until, command } = b;
  await until(`sessions.length && nav.current()`);
  // An install with a settings file is not new: no first-run question.
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click(); localStorage.removeItem('chattering.voice.v1')`);
  const key = async (k, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const hear = said => ev(`voiceEvent({ type: 'utterance', text: ${JSON.stringify(said)}, asrMs: 12 })`);
  const last = () => ev(`(() => { const d = voice.decisions.at(-1); return d && { said: d.said, status: d.status, action: d.decision && d.decision.action, summary: d.summary }; })()`);

  // Alt+L: the microphone streams, the pill says so, the overlay shows the words.
  await key('l', 'KeyL', 76, 1);
  await until(`voice.status === 'listening' && document.querySelector('#voiceListenPill[data-state="listening"]')`, 'Alt+L did not start listening: ' + await ev(`voice.error`).catch(() => ''));
  assert.equal(await ev(`JSON.parse(localStorage.getItem('chattering.voice.v1')).on`), true);
  // The first words come once the noise floor has 2 s of history and the recording paused.
  // Real audio in real time: under a loaded machine, allow up to 30 s.
  const heardWords = `/hello there/.test(document.querySelector('#voiceOverlay .vo-heard')?.textContent || '')`;
  for (let i = 0; i < 30 && !(await ev(heardWords)); i++) await new Promise(r => setTimeout(r, 1000));
  assert.ok(await ev(heardWords), 'the overlay never showed heard words: ' + await ev(`JSON.stringify({ status: voice.status, error: voice.error, heard: voice.heard })`));
  // The fake microphone beeps with pauses: its sentences are no command.
  // The recording's sentence ends in a long pause: handed on, decided, no command.
  for (let i = 0; i < 30 && !(await ev(`voice.decisions.some(d => d.status === 'ignored' && d.said === 'hello there')`)); i++) await new Promise(r => setTimeout(r, 1000));
  assert.ok(await ev(`voice.decisions.some(d => d.status === 'ignored' && d.said === 'hello there')`), 'the heard sentence was not decided');
  assert.match(await ev(`document.querySelector('#voiceOverlay .vo-decisions').textContent`), /hello there[\s\S]*not a command/);

  // Sure: done at once.
  await hear('open the appearance settings');
  await until(`settingsOpen && settingsPane === 'appearance'`, 'the settings did not open');
  assert.deepEqual(await last(), { said: 'open the appearance settings', status: 'done', action: 'settings', summary: 'settings: appearance' });
  // The settings show voice commands, switched on.
  await ev(`showSettings('sound')`);
  await until(`document.querySelector('#voiceSettings [data-voice="on"]')?.checked === true`, 'the settings do not show voice commands on');
  await until(`/TypeSafe key: from the server/.test(document.querySelector('#voiceKeyField')?.textContent || '')`, 'the key status is not shown');

  // Not sure: a suggestion, answered by voice.
  await hear('maybe the settings');
  await until(`voice.pending && document.querySelector('#voiceOverlay [data-vo="yes"]')`, 'no suggestion to confirm');
  await ev(`closeSettings(); goHome()`);
  await hear('yes');
  await until(`settingsOpen && voice.decisions.find(d => d.said === 'maybe the settings').status === 'done'`, 'yes did not run the suggestion');

  // A conversation from the list on the left (it lists the ones opened),
  // then dictation into its message box.
  await ev(`closeSettings(); open('pi:fixture/media.jsonl')`);
  await until(`viewKind === 'conversation'`, 'the conversation did not open');
  await ev(`goHome()`);
  // The left list rebuilds after going home: wait until it is settled.
  const listed = `voiceConversationRows().length > 0`;
  await until(listed, 'no conversation listed');
  await new Promise(r => setTimeout(r, 500));
  await until(listed, 'the conversation list emptied');
  await hear('open the first conversation');
  await until(`viewKind === 'conversation' && $('agentText')`, 'the voice did not open the conversation').catch(async e => { console.log('VOICEDEC', await ev(`JSON.stringify(voice.decisions.map(d => [d.said, d.status, d.decision && d.decision.action, d.summary, d.note]))`)); throw e; });
  await hear('start the microphone');
  await until(`voice.mode === 'dictation'`, 'dictation did not start');
  assert.match(await ev(`document.querySelector('#voiceListenPill .vl-state').textContent`), /dictating into the message box/);
  await hear('fix the flaky test in the queue');
  await until(`$('agentText').value === 'fix the flaky test in the queue'`, 'the words were not written');
  await hear('stop dictating');
  await until(`voice.mode === 'command'`, 'dictation did not stop');
  await b.screenshot('voice-overlay.png');

  // The record has every decision; Alt+L stops the microphone.
  const records = fs.readFileSync(path.join(b.home, '.local', 'share', 'chattering', 'voice-commands.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(records.some(r => r.action === 'settings') && records.some(r => r.outcome === 'confirmed'), JSON.stringify(records.map(r => r.action || r.outcome)));
  await key('l', 'KeyL', 76, 1);
  await until(`voice.status === 'off' && !document.querySelector('#voiceListenPill') && !document.querySelector('#voiceOverlay')`, 'Alt+L did not stop');
  assert.equal(await ev(`voice.audio`), null, 'the microphone is released');
  assert.deepEqual(b.exceptions, []);
});
