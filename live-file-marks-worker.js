'use strict';
importScripts('/linediff.js', '/live-file-marks.js');
self.onmessage = event => {
  const { id, ...input } = event.data;
  try {
    const result = LiveFileMarks.derive(input);
    self.postMessage({ id, ...result }, result.origins ? [result.origins.buffer] : []);
  } catch { self.postMessage({ id, unavailable: 'Inline annotations unavailable' }); }
};
