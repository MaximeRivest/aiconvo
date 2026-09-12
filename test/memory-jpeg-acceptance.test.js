'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { decodeImage } = require('../memory-images');
function Given(label, fn) { console.log('Given ' + label); return fn(); }
function When(label, fn) { console.log('When ' + label); return fn(); }
function Then(label, fn) { console.log('Then ' + label); return fn(); }
const segment = (tag, payload) => { const b = Buffer.from([255, tag, 0, 0, ...payload]); b.writeUInt16BE(payload.length + 2, 2); return b; };
const q = [0, ...Array(64).fill(1)];
const h = [0, 1, ...Array(15).fill(0), 0, 16, 1, ...Array(15).fill(0), 0];
const frame = [8, 0, 1, 0, 1, 1, 1, 0x11, 0];
const scan = [1, 1, 0, 0, 63, 0];
function jpeg({ quant = q, tables = h, components = frame, header = scan, mode = 0xc0, scans } = {}) {
  return Buffer.concat([Buffer.from([255,216]), segment(0xdb, quant), segment(0xc4, tables), segment(mode, components),
    ...(scans || [header]).flatMap(s => [segment(0xda, s), Buffer.from([0])]), Buffer.from([255,217])]);
}
const cases = {
  'empty quantization table': { quant: [] },
  'short quantization table': { quant: q.slice(0, -1) },
  'zero quantizer': { quant: [0, 0, ...Array(63).fill(1)] },
  'illegal quantization precision': { quant: [32, ...q.slice(1)] },
  'illegal quantization destination': { quant: [4, ...q.slice(1)] },
  'empty Huffman table': { tables: [] },
  'short Huffman counts': { tables: [0, 1] },
  'missing Huffman symbols': { tables: h.slice(0, -1) },
  'empty Huffman codes': { tables: [0, ...Array(16).fill(0)] },
  'oversubscribed Huffman tree': { tables: [0, 3, ...Array(15).fill(0), 0, 1, 2] },
  'all-ones Huffman code': { tables: [0, 2, ...Array(15).fill(0), 0, 1] },
  'illegal Huffman class': { tables: [32, ...h.slice(1)] },
  'illegal DC symbol': { tables: [0, 1, ...Array(15).fill(0), 12, ...h.slice(18)] },
  'duplicate Huffman symbol': { tables: [0, 0, 2, ...Array(14).fill(0), 0, 0] },
  'zero scan components': { header: [0, 0, 63, 0] },
  'missing quantization reference': { components: [...frame.slice(0,-1), 1] },
  'missing DC table reference': { header: [1, 1, 0x10, 0, 63, 0] },
  'missing AC table reference': { header: [1, 1, 1, 0, 63, 0] },
  'unknown scan component': { header: [1, 2, 0, 0, 63, 0] },
  'duplicate frame component': { components: [8,0,1,0,1,3,1,0x11,0,1,0x11,0,3,0x11,0] },
  'duplicate scan component': { header: [2,1,0,1,0,0,63,0] },
  'zero sampling factor': { components: [...frame.slice(0,7), 0x10, 0] },
  'baseline extended table selectors': { tables: [2, ...h.slice(1,18), 18, ...h.slice(19)], header: [1,1,0x22,0,63,0] },
  'progressive refinement AC magnitude': { mode: 0xc2, tables: [...h.slice(0,-1), 2],
    scans: [[1,1,0,0,0,0],[1,1,0,1,63,1],[1,1,0,1,63,0x10]] },
  'sequential spectral selection': { header: [1,1,0,1,63,0] },
  'sequential approximation': { header: [1,1,0,0,63,1] },
  'progressive DC spectral end': { mode: 0xc2, header: [1,1,0,0,1,0] },
  'progressive AC before DC': { mode: 0xc2, header: [1,1,0,1,63,0] },
  'progressive illegal refinement': { mode: 0xc2, header: [1,1,0,0,0,0x21] },
  'progressive overlapping initial scans': { mode: 0xc2, scans: [[1,1,0,0,0,0],[1,1,0,0,0,0]] },
};
for (const [name, options] of Object.entries(cases)) test('Scenario: reject JPEG ' + name, () => {
  const bytes = Given('a structurally framed JPEG with ' + name, () => jpeg(options));
  const admit = When('these source bytes reach admission', () => () => decodeImage({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }));
  Then('admission rejects without entropy decoding or inference', () => assert.throws(admit, /Incomplete visual input/));
});
for (const mode of [0xc0, 0xc1, 0xc2]) test('Scenario: preserve supported JPEG framing ' + mode, () => {
  const bytes = Given('valid grayscale tables and sequential or progressive scans', () => jpeg({ mode,
    ...(mode === 0xc2 ? { scans: [[1,1,0,0,0,1],[1,1,0,0,0,0x10],[1,1,0,1,63,0]] } : {}) }));
  const result = When('structural admission runs (synthetic entropy is not decoded)', () => decodeImage({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }));
  Then('dimensions are preserved', () => assert.deepEqual([result.width, result.height], [1,1]));
});
