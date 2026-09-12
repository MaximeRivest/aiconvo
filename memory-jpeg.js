'use strict';
// Structural admission, NOT entropy decoding. Original bytes are delivered
// unchanged; provider decoding errors must surface, never drop an attachment.
function readQuantization(bytes, p, end, tables, fail) {
  if (p === end) fail('empty JPEG quantization segment');
  while (p < end) {
    const info = bytes[p++], precision = info >> 4, id = info & 15;
    if (precision > 1 || id > 3 || p + 64 * (precision + 1) > end) fail('invalid JPEG quantization table');
    for (let n = 0; n < 64; n++, p += precision + 1) {
      if (!(precision ? bytes.readUInt16BE(p) : bytes[p])) fail('zero JPEG quantizer');
    }
    tables.set(id, precision);
  }
}

function readHuffman(bytes, p, end, tables, fail) {
  if (p === end) fail('empty JPEG Huffman segment');
  while (p < end) {
    const info = bytes[p++], kind = info >> 4, id = info & 15;
    if (kind > 1 || id > 3 || p + 16 > end) fail('invalid JPEG Huffman table');
    let count = 0, available = 1;
    for (let n = 0; n < 16; n++) {
      const codes = bytes[p++]; count += codes; available = available * 2 - codes;
      // JPEG reserves the all-ones code, so even a complete tree is illegal.
      if (available <= 0) fail('invalid JPEG Huffman code counts');
    }
    if (!count || count > 256 || p + count > end) fail('invalid JPEG Huffman symbols');
    const symbols = [...bytes.subarray(p, p + count)]; p += count;
    if (new Set(symbols).size !== count || symbols.some(s => kind === 0 ? s > 11 : (s & 15) > 10)) fail('invalid JPEG Huffman values');
    tables.set(info, symbols);
  }
}

function inspectJpeg(bytes, limits, fail) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('JPEG signature mismatch');
  let offset = 2, frame, mode, scans = 0, restartInterval = 0;
  const quantization = new Map(), huffman = new Map(), components = new Map();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) fail('invalid JPEG marker framing');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scans || offset !== bytes.length || [...components.values()].some(c => c.bits[0] < 0)) fail('invalid JPEG end');
      return frame;
    }
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) fail('invalid JPEG marker');
    const size = bytes.readUInt16BE(offset), end = offset + size;
    if (size < 2 || end > bytes.length) fail('truncated JPEG segment');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 8) fail('ambiguous JPEG frame');
      const depth = bytes[offset + 2], height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5), channels = bytes[offset + 7];
      if (depth !== 8 || ![1, 3].includes(channels) || size !== 8 + 3 * channels) fail('unsupported JPEG frame');
      if (!width || !height || width > limits.width || height > limits.height || width * height > limits.pixels) fail('JPEG dimensions exceed budget');
      for (let p = offset + 8; p < end; p += 3) {
        const id = bytes[p], x = bytes[p + 1] >> 4, y = bytes[p + 1] & 15, table = bytes[p + 2];
        if (components.has(id) || x < 1 || x > 4 || y < 1 || y > 4 || table > 3) fail('invalid JPEG frame component');
        components.set(id, { table, samples: x * y, bits: Array(64).fill(-1) });
      }
      frame = { width, height }; mode = marker;
    } else if (marker === 0xdb) {
      readQuantization(bytes, offset + 2, end, quantization, fail);
    } else if (marker === 0xc4) {
      readHuffman(bytes, offset + 2, end, huffman, fail);
    } else if (marker === 0xdd) {
      if (size !== 4) fail('invalid JPEG restart interval');
      restartInterval = bytes.readUInt16BE(offset + 2);
    } else if (marker !== 0xda && marker !== 0xfe && !(marker >= 0xe0 && marker <= 0xef)) {
      fail('unsupported JPEG coding or marker');
    }
    if (marker === 0xda) {
      const count = bytes[offset + 2];
      if (!frame || size < 6 || !count || count > components.size || size !== 6 + 2 * count) fail('invalid JPEG scan header');
      const start = bytes[end - 3], stop = bytes[end - 2], high = bytes[end - 1] >> 4, low = bytes[end - 1] & 15;
      const progressive = mode === 0xc2;
      if (progressive ? (start > stop || stop > 63 || (!start && stop !== 0) || (start && count !== 1) || high > 13 || low > 13 || (high && high !== low + 1))
        : (start !== 0 || stop !== 63 || high !== 0 || low !== 0)) fail('invalid JPEG scan parameters');
      const seen = new Set(); let samples = 0;
      for (let p = offset + 3; p < end - 3; p += 2) {
        const id = bytes[p], tables = bytes[p + 1], dc = tables >> 4, ac = tables & 15, c = components.get(id);
        if (!c || seen.has(id) || dc > 3 || ac > 3 || (mode === 0xc0 && (dc > 1 || ac > 1))) fail('invalid JPEG scan component');
        seen.add(id); samples += c.samples;
        if (!quantization.has(c.table) || (mode === 0xc0 && quantization.get(c.table) !== 0)) fail('missing or unsupported JPEG quantization reference');
        if ((!progressive || (!start && !high)) && !huffman.has(dc)) fail('missing JPEG DC table reference');
        if ((!progressive || start) && !huffman.has(16 + ac)) fail('missing JPEG AC table reference');
        if (progressive && ((!start && ac !== 0) || (start && dc !== 0))) fail('invalid JPEG unused table selector');
        if (!progressive && huffman.get(16 + ac).some(s => !(s & 15) && s !== 0 && s !== 0xf0)) fail('invalid sequential JPEG AC symbol');
        if (progressive && start && high && huffman.get(16 + ac).some(s => (s & 15) > 1)) fail('invalid JPEG refinement AC symbol');
        if (progressive && start && c.bits[0] < 0) fail('JPEG AC scan precedes DC');
        for (let n = start; n <= stop; n++) {
          if (high ? c.bits[n] !== high : c.bits[n] !== -1) fail('invalid JPEG scan progression');
          c.bits[n] = low;
        }
      }
      if (count > 1 && samples > 10) fail('invalid JPEG interleaved sampling');
      scans++; offset = end; let entropy = 0, restart = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropy++; continue; }
        const start = offset++;
        while (bytes[offset] === 0xff) offset++;
        const code = bytes[offset];
        if (code === 0) { offset++; entropy++; continue; }
        if (code >= 0xd0 && code <= 0xd7) {
          if (!restartInterval || code !== 0xd0 + (restart++ % 8)) fail('invalid JPEG restart marker');
          offset++; continue;
        }
        offset = start; break;
      }
      if (!entropy) fail('empty JPEG scan');
    } else offset = end;
  }
  fail('JPEG end missing');
}
module.exports = { inspectJpeg };
