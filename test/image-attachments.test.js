'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('image attachments keep valid files after a decode failure and preserve native names and limits', { timeout: 60000 }, async t => {
  const { evaluate: ev, until, exceptions } = await viewerBrowser(t);
  await until(`sessions.length && nav.current()`);
  await ev(`open('pi:fixture/media.jsonl')`);
  await until(`!!$('agentText')`);
  await ev(`window.savedErrToast=errToast;window.imageErrors=[];errToast=message=>imageErrors.push(message)`);
  const result = await ev(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    window._agentImages=[];
    await addAgentFiles([new File(['broken'],'broken.png',{type:'image/png'}),new File([blob],'valid.png',{type:'image/png'})]);
    return {names:window._agentImages.map(i=>i.name),errors:imageErrors.slice()};
  })()`);
  assert.deepEqual(result.names, ['valid.png']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /could not decode.*broken\.png/);
  assert.deepEqual(await ev(`chatteringAcceptImage('image/jpeg','dGVzdA==','Photo.jpg');window._agentImages.map(i=>i.name)`), ['valid.png', 'Photo.jpg']);
  await ev(`for(let i=0;i<10;i++)chatteringAcceptImage('image/jpeg','dGVzdA==');errToast=savedErrToast`);
  assert.equal(await ev(`window._agentImages.length`), 8);
  assert.equal(await ev(`imageErrors.at(-1)`), 'Up to 8 images per message.');
  assert.deepEqual(exceptions, []);
});
