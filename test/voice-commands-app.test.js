'use strict';
// The voice commands that act on the page, run on the real app: the voice
// cursor ("highlight the last answer"), buttons by name (the message's own,
// closed menus), folding, continuous scrolling and its quick "stop", zen,
// the conversation tree, timeline marks, and in a file find, select and code
// chunks. Decisions are given directly: what Jev picks is measured against
// the real Jev elsewhere (design/64); here, that each decision does the
// right thing on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// An hour ago: the home timeline draws the marks of its visible range.
const base = Date.now() - 3600 * 1000;
const msg = (id, parentId, ts, message) => ({ type: 'message', id, parentId, timestamp: new Date(base + Number(ts) * 1000).toISOString(), message });
const text = t => ({ type: 'text', text: t });

test('voice commands on the page: cursor, buttons, folds, scrolling, zen, tree, marks, find, select, chunks', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t, {
    setup: home => {
      const work = path.join(home, 'work');
      fs.writeFileSync(path.join(work, 'notes.md'), [
        '# Notes', '', 'The first paragraph talks about parse_config and more.', 'It has two lines.', '',
        'Second paragraph. It ends here.', '', '```python', 'x = 1', 'print(x)', '```', '', 'Between the chunks.', '', '```python', 'y = 2', '```', '',
      ].join('\n'));
      const long = Array.from({ length: 80 }, (_, i) => 'Line ' + i + ' of a long answer, so that the page has something to scroll through.').join('\n\n');
      fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/work.jsonl'), [
        { type: 'session', version: 3, id: 'work', cwd: work },
        msg('u1', null, '00', { role: 'user', content: [text('Please fix the parser')] }),
        msg('a1', 'u1', '01', { role: 'assistant', model: 'fixture', content: [{ type: 'thinking', thinking: 'I should read the parser first.' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: path.join(work, 'notes.md') } }] }),
        msg('r1', 'a1', '02', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [text('contents')], isError: false }),
        msg('a2', 'r1', '03', { role: 'assistant', model: 'fixture', content: [text('I read it; now the edit.'), { type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: path.join(work, 'notes.md'), edits: [{ oldText: 'x = 1', newText: 'x = 1' }] } }] }),
        msg('r2', 'a2', '04', { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [text('Updated')], isError: false }),
        msg('a3', 'r2', '05', { role: 'assistant', model: 'fixture', content: [text('Done: the parser handles empty input now.')] }),
        msg('u2', 'a3', '06', { role: 'user', content: [text('Thanks, and the docs?')] }),
        msg('a4', 'u2', '07', { role: 'assistant', model: 'fixture', content: [text('The docs are updated too.\n\n' + long)] }),
      ].map(JSON.stringify).join('\n') + '\n');
    },
  });
  const { evaluate: ev, until } = b;
  await until(`sessions.length && nav.current()`);
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click()`);
  // Listening on, without a microphone: the page part only.
  await ev(`voice.on = true; voice.status = 'listening'; voicePaint()`);
  const run = (action, args = {}, said = '') => ev(`(async () => { const e = { said: ${JSON.stringify(said)}, at: Date.now(), status: 'deciding' }; voice.decisions.push(e); await voiceRun(e, { action: ${JSON.stringify(action)}, args: ${JSON.stringify(args)}, confidence: 0.99 }); return { status: e.status, summary: e.summary, note: e.note }; })()`);
  const done = async (action, args, said) => { const r = await run(action, args, said); assert.equal(r.status, 'done', action + ' ' + JSON.stringify(args) + ': ' + r.note); return r.summary; };
  const controls = said => ev(`voiceContext(${JSON.stringify(said)}).then(c => c.lists.controls.map(x => x.label))`);
  const press = async (said, pattern) => {
    const labels = await controls(said);
    const i = labels.findIndex(l => pattern.test(l));
    assert.ok(i >= 0, 'no control like ' + pattern + ' in ' + JSON.stringify(labels.slice(0, 60)));
    return done('press', { control: 'c' + i }, said);
  };

  await ev(`open('pi:fixture/work.jsonl')`);
  await until(`viewKind === 'conversation' && document.querySelectorAll('#conversationTranscript .msg.assistant').length >= 2`, 'the conversation did not render');

  // The voice cursor.
  assert.match(await done('point', { thing: 'answer', place: 'last' }), /highlighted the last answer: .The docs are updated/);
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'a4');
  await done('point', { thing: 'message', place: 'previous' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'u2', 'the previous message is mine');
  await done('point', { thing: 'answer', place: 'previous' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.dataset.eid`), 'a3');
  assert.equal(await ev(`document.querySelectorAll('.voice-focus').length`), 1, 'one highlight at a time');

  // Its buttons, by name: its own first (copy, read, the "more…" menu's
  // items), the review of its turn; not the forty copies of other messages.
  const labels = await controls('copy it');
  assert.ok(labels.some(l => /^copy .* on the highlighted message$/.test(l)), JSON.stringify(labels));
  assert.ok(labels.some(l => /More message actions › fork · on the highlighted message/.test(l)), 'the more… menu items are offered');
  assert.ok(labels.some(l => /Review whole turn/.test(l)), 'the turn\u2019s review');
  assert.equal(labels.filter(l => /^copy\b/.test(l)).length, 1, 'only the highlighted message\u2019s copy');
  assert.ok(labels.some(l => /Attachments and conversation options › Conversation tree/.test(l)), 'the + menu\u2019s items');
  await ev(`window.__copied = null; navigator.clipboard.writeText = async t => { window.__copied = t; }`);
  await press('copy it', /^copy .* on the highlighted message$/);
  await until(`window.__copied === 'Done: the parser handles empty input now.'`, 'copy did not copy the highlighted message');

  // Folding: the thinking opens with its group of steps; steps close.
  await done('fold', { how: 'open', what: 'thinking' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .msg.thinking')].every(d => d.open && d.closest('.toolgroup').open)`), true);
  await done('fold', { how: 'close', what: 'steps' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .toolgroup')].some(d => d.open)`), false);
  // "The next step" from the highlighted answer goes on, in page order; the
  // first group of steps is before it.
  await done('point', { thing: 'steps', place: 'first' });
  assert.equal(await ev(`document.querySelector('.voice-focus')?.classList.contains('toolgroup') && document.querySelector('.voice-focus').open`), true, 'pointing at steps opens them');
  await done('point', { thing: 'steps', place: 'next' });
  assert.equal(await ev(`[...document.querySelectorAll('#conversationTranscript .toolgroup')].indexOf(document.querySelector('.voice-focus'))`), 1);
  assert.equal((await run('point', { thing: 'steps', place: 'next' })).note, 'that was the last group of steps');

  // Continuous scrolling, and "stop" caught in the live words.
  await ev(`$('view').scrollTop = 0`);
  assert.match(await done('autoscroll', { direction: 'down', speed: 'fast' }), /scrolling down/);
  await until(`$('view').scrollTop > 60`, 'the page did not scroll');
  assert.match(await ev(`$('voiceListenPill').textContent`), /scrolling ↓/);
  await done('autoscroll_adjust', { how: 'faster' });
  await ev(`voiceEvent({ type: 'heard', committed: 'start scrolling down', stable: 'stop', volatile: '', decided: 3, windowSeconds: 2, asrMs: 5 })`);
  assert.equal(await ev(`voice.autoscroll`), null, '"stop" in the live words stops at once');
  const stopped = await ev(`$('view').scrollTop`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await ev(`$('view').scrollTop`), stopped);
  assert.equal(await ev(`voice.decisions.some(d => /scrolling stopped: heard .stop/.test(d.summary || ''))`), true);
  // The sentence "stop" arrives after: it applies, harmlessly.
  assert.equal(await ev(`VOICE_ACTIONS.autoscroll_adjust.available()`), true);
  await done('autoscroll_adjust', { how: 'stop' }, 'stop');
  // A wheel takes the page back.
  await done('autoscroll', { direction: 'up' });
  await ev(`$('view').dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }))`);
  assert.equal(await ev(`voice.autoscroll`), null, 'a wheel stops it');

  // Zen.
  await done('zen', { how: 'on' });
  assert.equal(await ev(`document.body.classList.contains('zen')`), true);
  await done('zen', { how: 'toggle' });
  assert.equal(await ev(`document.body.classList.contains('zen')`), false);

  // The + menu's "Conversation tree", then moving in the tree and its boxes numbered.
  await press('open the conversation tree', /Attachments and conversation options › Conversation tree/);
  await until(`viewKind === 'tree' && treeNav && treeNav.sel`, 'the tree did not open');
  const sel = await ev(`treeNav.sel`);
  await done('tree_move', { move: 'up' });
  assert.notEqual(await ev(`treeNav.sel`), sel, 'up moves to the parent');
  await done('tree_move', { move: 'down' });
  assert.equal(await ev(`treeNav.sel`), sel);
  assert.ok(await ev(`voicePicks().items.filter(it => it.kind === 'box' && it.region === 'tree').length`) >= 3, 'the tree\u2019s boxes can be picked');

  // Home: the timeline's marks can be picked, named with their project.
  await ev(`goHome()`);
  await until(`voicePicks().items.some(it => it.kind === 'mark')`, 'no timeline mark is pickable: ' + await ev(`document.querySelectorAll('.tmark').length`));
  assert.match(await ev(`voicePicks().items.find(it => it.kind === 'mark').title`), /· project /);

  // A file: find (parse config finds parse_config), select, code chunks.
  const notes = await ev(`sessions.find(s => s.key === 'pi:fixture/work.jsonl').cwd + '/notes.md'`);
  await ev(`openLiveFile(${JSON.stringify(notes)})`);
  await until(`voiceEditor() && voiceEditor().listCells && voiceEditor().listCells().length === 2`, 'the notebook did not open');
  const selected = `(() => { const s = voiceEditor().view.state; return s.sliceDoc(s.selection.main.from, s.selection.main.to); })()`;
  assert.deepEqual(await ev(`voiceFoundList('find parse config').found.map(x => x.id)`), ['parse config', 'config', 'parse'], 'what is in the file, longest first');
  assert.match(await done('find', { text: 'parse config' }), /1 of 1 · line 3/);
  assert.equal(await ev(selected), 'parse_config');
  await done('select', { what: 'paragraph' });
  assert.equal(await ev(selected), 'The first paragraph talks about parse_config and more.\nIt has two lines.');
  await done('select', { what: 'sentence' });
  assert.equal(await ev(selected), 'The first paragraph talks about parse_config and more.');
  await done('select', { what: 'lines', from_line: '1', to_line: '3' });
  assert.equal(await ev(selected), '# Notes\n\nThe first paragraph talks about parse_config and more.');
  await done('select', { what: 'between', from: 'Second', to: 'here' });
  assert.equal(await ev(selected), 'Second paragraph. It ends here');
  assert.match(await done('chunk', { place: 'next' }), /chunk 1 of 2 \(python\)/);
  await done('select', { what: 'chunk' });
  assert.match(await ev(selected), /^```python\nx = 1\nprint\(x\)\n```$/);
  assert.match(await done('chunk', { place: 'next' }), /chunk 2 of 2/);
  assert.equal((await run('chunk', { place: 'next' })).note, 'that was the last chunk');
  assert.match(await done('chunk', { place: 'first' }), /chunk 1 of 2/);
  await done('select', { what: 'none' });
  assert.equal(await ev(selected), '');
  assert.equal((await run('find', { text: 'no such words' })).note, '\u201cno such words\u201d is not in the file');
});
