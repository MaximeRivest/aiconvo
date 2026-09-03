'use strict';

// execFile with a silence limit. The normal execFile timeout limits total run
// time. This separate timer only measures time since the last stdout/stderr
// byte, so a model that is still streaming can continue normally.
function execFileWithActivityTimeout(execImpl, file, args, options = {}, hooks = {}) {
  const activityTimeoutMs = Math.max(0, Number(hooks.activityTimeoutMs) || 0);
  const killGraceMs = Math.max(1, Number(hooks.killGraceMs) || 5000);
  let activityTimer = null;
  let killTimer = null;
  let child = null;
  let settled = false;
  let activityError = null;

  const cleanup = () => {
    clearTimeout(activityTimer);
    clearTimeout(killTimer);
    activityTimer = null;
    killTimer = null;
  };

  const promise = new Promise((resolve, reject) => {
    const finish = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!err) return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      const failure = activityError || err;
      failure.stdout = String(stdout || err.stdout || '');
      failure.stderr = String(stderr || err.stderr || '');
      reject(failure);
    };

    const arm = () => {
      if (!activityTimeoutMs || settled) return;
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        if (settled) return;
        activityError = new Error(`memory model stopped responding: no pi output for ${Math.round(activityTimeoutMs / 60000) || '<1'} minutes`);
        activityError.code = 'MODEL_ACTIVITY_TIMEOUT';
        activityError.activityTimeoutMs = activityTimeoutMs;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, killGraceMs);
      }, activityTimeoutMs);
    };

    try {
      child = execImpl(file, args, options, finish);
      if (child.stdout) child.stdout.on('data', data => {
        arm();
        try { if (hooks.onStdout) hooks.onStdout(data); } catch {}
      });
      if (child.stderr) child.stderr.on('data', data => {
        arm();
        try { if (hooks.onStderr) hooks.onStderr(data); } catch {}
      });
      if (hooks.onChild) hooks.onChild(child);
      arm();
    } catch (error) {
      finish(error, '', '');
    }
  });

  return promise;
}

module.exports = { execFileWithActivityTimeout };
