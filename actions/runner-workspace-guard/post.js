'use strict';

// POST entry point — runs after ALL main steps and after every other action's post step,
// because post steps execute in reverse order and this action is placed first in the job.
//
// This is the only correct place for the restore. An `if: always()` main step is TOO EARLY:
// actions/checkout's own post step rewrites `.git/config` (unsetting the auth header) and, in
// a container job, does so as ROOT — re-poisoning exactly one file behind an earlier restore.
// One root-owned file is enough to kill the next host job's checkout. The selftest caught this.
//
// Still not sufficient on its own: a hard-cancelled job or a dead runner skips post steps too.
// That residue is why the preflight and `hub runner-doctor` exist and are not optional.

const { config, runScript } = require('./lib.js');

const cfg = config();

if (cfg.mode === 'restore') {
  runScript('restore.sh', cfg);
}
