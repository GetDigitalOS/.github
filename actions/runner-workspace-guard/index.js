'use strict';

// MAIN entry point.
//
// mode: preflight -> run the preflight now (it must happen BEFORE checkout, which is the
//                    whole point: fail closed with evidence instead of letting checkout
//                    surface a misleading "index.lock: Permission denied").
//
// mode: restore   -> do NOTHING here, on purpose. The restore has to happen after every other
//                    post step (notably actions/checkout's, which rewrites .git/config as root
//                    in a container job). Post steps run in REVERSE order, so this action is
//                    placed FIRST in the job and its work happens in post.js, last.

const { config, runScript } = require('./lib.js');

const cfg = config();

if (cfg.mode === 'preflight') {
  runScript('preflight.sh', cfg);
} else {
  console.log(
    'runner-workspace-guard: restore armed — the host workspace will be chowned back in this ' +
      "action's post step, which runs after every other post step (including checkout's).",
  );
}
