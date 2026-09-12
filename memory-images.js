'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { revision } = require('./memory-automation');
const LIMITS = Object.freeze({ sourceBytes: 128 * 1024 * 1024, imageBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, count: 32, width: 2048, height: 2048, pixels: 4 * 1024 * 1024,
  callImages: 4, imageTokens: 16384 });
const fail = message => { const e = new Error('Incomplete visual input: ' + message); e.code = 'MEMORY_IMAGE_INPUT'; throw e; };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// PNG structural/zlib admission, not a general pixel decoder. Support static
// grayscale, palette, RGB and alpha variants, including Adam7. Never transcode.
function validatePng(bytes, limits = LIMITS) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail('PNG signature mismatch');
  let offset = 8, width, height, channels, depth, color, interlace, palette = false, ended = false, idatEnded = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('truncated PNG chunk');
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) fail('truncated PNG body');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('PNG CRC mismatch');
    if (offset === 8 && type !== 'IHDR') fail('PNG header missing');
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) fail('ambiguous PNG header');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > limits.width || height > limits.height || width * height > limits.pixels) fail('PNG dimensions exceed budget');
      depth = data[8]; color = data[9]; interlace = data[12];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[10] || data[11] || interlace > 1) fail('unsupported PNG header');
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
    } else if (type === 'IDAT') {
      if (idatEnded) fail('non-contiguous PNG image data');
      compressed.push(data);
    } else {
      if (compressed.length) idatEnded = true;
      if (type === 'PLTE') {
        if (palette || compressed.length || !size || size % 3 || size > 768 || (color === 3 && size / 3 > 2 ** depth)) fail('invalid PNG palette');
        palette = true;
      }
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('animated PNG is unsupported');
      if (type === 'IEND') {
        if (size || !compressed.length || end !== bytes.length) fail('invalid PNG end');
        ended = true;
      } else if (!/^[a-z]/.test(type) && type !== 'PLTE') fail('unsupported critical PNG chunk');
    }
    offset = end;
  }
  if (!ended) fail('PNG end missing');
  if (color === 3 && !palette) fail('PNG palette missing');
  const passes = interlace ? [[0,0,8,8], [4,0,8,8], [0,4,4,8], [2,0,4,4], [0,2,2,4], [1,0,2,2], [0,1,1,2]] : [[0,0,1,1]];
  const strides = passes.flatMap(([x,y,dx,dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return w && h ? Array(h).fill(1 + Math.ceil(w * channels * depth / 8)) : [];
  });
  const expected = strides.reduce((sum, n) => sum + n, 0), input = Buffer.concat(compressed);
  let result;
  try { result = zlib.inflateSync(input, { maxOutputLength: expected, info: true }); }
  catch { fail('invalid or oversized PNG pixel stream'); }
  if (result.buffer.length !== expected || result.engine.bytesWritten !== input.length) fail('PNG pixel stream length mismatch');
  let pos = 0;
  for (const stride of strides) { if (result.buffer[pos] > 4) fail('invalid PNG scanline filter'); pos += stride; }
  return { width, height };
}

function decodeImage(block, limits = LIMITS) {
  if (!block || block.type !== 'image') fail('image block missing');
  if (block.url || block.source?.url || (block.source && block.source.type !== 'base64')) fail('URL or unsupported image source');
  if (block.source && (block.data !== undefined || block.mimeType !== undefined)) fail('ambiguous image encoding');
  const mime = block.source ? block.source.media_type : block.mimeType;
  const data = block.source ? block.source.data : block.data;
  if (!['image/png', 'image/jpeg'].includes(mime)) fail('only static PNG and JPEG are supported (received ' + String(mime) + ')');
  if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(limits.imageBytes / 3)) fail('encoded image exceeds budget or is empty');
  if (data.length % 4 || /[^A-Za-z0-9+/=]/.test(data) || !/^[^=]*={0,2}$/.test(data)) fail('invalid base64');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > limits.imageBytes || bytes.toString('base64') !== data) fail('noncanonical or oversized base64');
  const dimensions = mime === 'image/png' ? validatePng(bytes, limits) : require('./memory-jpeg').inspectJpeg(bytes, limits, fail);
  return { type: 'image', data, mimeType: mime, bytes: bytes.length, identity: revision(bytes), ...dimensions };
}

function sourceSnapshot(file, limits = LIMITS) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limits.sourceBytes) fail('source is not a bounded regular file');
    // Read at most the admitted size plus one byte, even if a writer keeps
    // growing the source. Never allocate an unbounded readFile buffer.
    const buffer = Buffer.alloc(before.size + 1); let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, length))) length += n;
    const after = fs.fstatSync(fd), current = fs.statSync(file);
    if (length !== before.size || before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('source changed while reading');
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('source is not valid UTF-8'); }
    return { text, revision: revision(bytes), stat: after };
  } finally { fs.closeSync(fd); }
}

function hydrate(snapshot, data, limits = LIMITS) {
  const entries = new Map();
  for (const line of snapshot.text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { fail('malformed source JSONL'); }
    if (d.type === 'session') continue;
    const id = d.id || d.uuid;
    if (id) {
      if (entries.has(id)) fail('ambiguous entry id');
      entries.set(id, d);
    }
  }
  const parents = new Map(data.entryParents || []);
  const checked = new Set();
  for (const id of parents.keys()) {
    const chain = new Set(); let current = id;
    while (current != null && parents.has(current) && !checked.has(current)) {
      if (chain.has(current)) fail('cyclic source ancestry');
      chain.add(current); current = parents.get(current);
    }
    for (const id of chain) checked.add(id);
  }
  let total = 0, count = 0;
  const seen = new Set();
  const rows = (data.messages || []).map((m, id) => {
    const images = (m.images || []).map(ref => {
      if (!m.eid || ref.entry !== m.eid || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(ref.path)) fail('invalid message attachment reference');
      const reference = ref.entry + ':' + ref.path;
      if (seen.has(reference)) fail('ambiguous duplicate attachment reference');
      seen.add(reference);
      let block = entries.get(ref.entry)?.message?.content;
      const parts = ref.path.split('.');
      parts.forEach((n, i) => { block = Array.isArray(block) ? block[Number(n)] : null; if (i < parts.length - 1) block = block?.content; });
      const image = decodeImage(block, limits);
      if (ref.mime !== image.mimeType) fail('attachment MIME changed');
      total += image.bytes; count++;
      if (total > limits.totalBytes || count > limits.count) fail('session image budget exceeded');
      return { ...image, reference, messageIndex: id, entry: m.eid, path: ref.path };
    });
    return { ...m, id, images, parent: parents.get(m.eid) ?? null };
  });
  // Detect raw attachments omitted by parsing, including unsupported/URL
  // blocks and image-only turns. Meta/sidechain entries are not this session.
  for (const [id, d] of entries) {
    if (d.isMeta || d.isSidechain) continue;
    const scan = (content, prefix = []) => {
      if (!Array.isArray(content)) return;
      content.forEach((b, i) => {
        if (b?.type === 'image' && !seen.has(id + ':' + prefix.concat(i).join('.'))) fail('source image has no attributed message');
        if (b?.type === 'tool_result') scan(b.content, prefix.concat(i));
      });
    };
    scan(d.message?.content);
  }
  const byEntry = new Map();
  for (const row of rows) if (row.role === 'assistant') byEntry.set(row.eid, row);
  for (const row of rows) {
    let parent = parents.get(row.eid), assistant = null;
    const visited = new Set([row.eid]);
    while (parent != null && !visited.has(parent)) {
      visited.add(parent);
      if (byEntry.has(parent)) { assistant = byEntry.get(parent); break; }
      parent = parents.get(parent);
    }
    row.assistantBefore = assistant ? { id: assistant.id, entry: assistant.eid, text: assistant.text || '' } : null;
  }
  return { rows, revision: snapshot.revision, identity: revision('multimodal-v1\0' + snapshot.revision), imageCount: count };
}

function packRows(rows, tokenBudget, limits = LIMITS) {
  const groups = []; let group = [], cost = 0, count = 0;
  for (const row of rows) {
    const text = JSON.stringify({ id: row.id, entry: row.eid, parent: row.parent, offBranch: !!row.off,
      role: row.role, name: row.name, text: row.text || '', assistantBefore: row.assistantBefore,
      attachments: row.images.map(i => ({ reference: i.reference, identity: i.identity, width: i.width, height: i.height })) });
    const tokens = Math.ceil(Buffer.byteLength(text) / 2) + row.images.length * limits.imageTokens;
    if (tokens > tokenBudget || row.images.length > limits.callImages) fail('one attributed message exceeds the per-call budget');
    if (group.length && (cost + tokens > tokenBudget || count + row.images.length > limits.callImages)) {
      groups.push(group); group = []; cost = 0; count = 0;
    }
    group.push({ ...row, packedText: text }); cost += tokens; count += row.images.length;
  }
  if (group.length) groups.push(group);
  return groups.map((group, i) => {
    const images = group.flatMap(row => row.images);
    const manifest = images.map((image, n) => ({ attachment: n + 1, messageIndex: image.messageIndex, reference: image.reference, identity: image.identity }));
    return { text: `SECTION ${i + 1}/${groups.length}\nAttachment order: ${JSON.stringify(manifest)}\n` + group.map(r => r.packedText).join('\n'),
      images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })), ids: group.map(r => r.id) };
  });
}
module.exports = { LIMITS, crc32, validatePng, decodeImage, sourceSnapshot, hydrate, packRows };
