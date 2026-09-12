'use strict';
// Pi currently exits immediately after printing --list-models. A regular stdout
// file avoids losing buffered pipe output on exit (verified on this Linux host).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function execFileWithFileStdout(file, args, options, callback) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconvo-catalog-'));
    const stdoutFile = path.join(dir, 'stdout');
    // The shell program is constant. Executable/arguments stay separate argv
    // values; the private output path is passed via the environment, not code.
    execFile('/bin/sh', ['-c', 'exec "$@" > "$AICONVO_STDOUT_FILE"',
      'aiconvo-catalog', file, ...args], {
      ...options, env: { ...process.env, ...options.env, AICONVO_STDOUT_FILE: stdoutFile },
    }, (error, _pipeOutput, stderr) => {
      let stdout = '';
      try {
        if (!error) {
          const limit = options.maxBuffer || 4 * 1024 * 1024;
          if (fs.statSync(stdoutFile).size > limit) {
            throw Object.assign(new Error('Model catalog exceeds maximum output size'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
          }
          stdout = fs.readFileSync(stdoutFile, 'utf8');
        }
      } catch (readError) { error = readError; }
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (cleanupError) { error ||= cleanupError; }
      callback(error, stdout, stderr);
    });
  } catch (error) {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
    catch (cleanupError) { error = cleanupError; }
    // Match execFile's asynchronous callback contract, including setup failure.
    // Otherwise listPiModels can overwrite its own modelsPending reset.
    queueMicrotask(() => callback(error, '', ''));
  }
}

module.exports = { execFileWithFileStdout };
