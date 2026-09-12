'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

function sessionCachePath(directory, key) {
  const legacy = key.replace(/[:\/\\]/g, '__') + '.json';
  // Leave room under NAME_MAX for writeFileAtomic's temporary suffix.
  // Keep short existing names; long keys retain identity via SHA-256.
  const name = Buffer.byteLength(legacy, 'utf8') <= 180 ? legacy
    : 'sha256-' + crypto.createHash('sha256').update(key).digest('hex') + '.json';
  return path.join(directory, name);
}

module.exports = { sessionCachePath };
