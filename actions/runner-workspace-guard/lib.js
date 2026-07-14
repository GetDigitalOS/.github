'use strict';

// Shared plumbing for the guard's main and post entry points.
//
// Deliberately ZERO dependencies — no @actions/core, no node_modules, no bundling step. This
// action guards CI infrastructure; it must not itself need a build to be trustworthy, and a
// dependency tree is a supply chain into the box that every repo's CI runs on.
//
// The real logic lives in preflight.sh / restore.sh. These are the SHIPPED artifacts, and the
// test suite executes those exact files under GitHub's exact shell invocation — nothing is
// transcribed, so a regression fails the suite rather than production.

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

function input(name, fallback = '') {
  // GitHub exposes `with:` inputs as INPUT_<NAME>, uppercased, spaces->underscores.
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * Run one of the shipped shell scripts under GitHub's exact `shell: bash` invocation.
 *
 * `--noprofile --norc -eo pipefail` is what GitHub actually expands `shell: bash` to. Using
 * anything else here would mean the script is tested under one shell and shipped under
 * another — which is the sort of gap the whole incident lived in.
 */
function runScript(script, { mode, ownerUid, ownerGid, extraPaths }) {
  const res = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', join(__dirname, script)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GUARD_UID: ownerUid,
        GUARD_GID: ownerGid,
        // Accept commas as well as newlines — YAML makes a one-line list far easier to write,
        // and a guard people find fiddly to configure is a guard people leave off.
        GUARD_EXTRA_PATHS: extraPaths.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).join('\n'),
      },
    },
  );
  if (res.status !== 0) {
    console.log(`::error::runner-workspace-guard: ${mode} failed (exit ${res.status})`);
    process.exit(res.status === null ? 1 : res.status);
  }
}

function config() {
  const mode = input('mode');
  if (mode !== 'preflight' && mode !== 'restore') {
    console.log(`::error::runner-workspace-guard: mode must be 'preflight' or 'restore' (got '${mode}')`);
    process.exit(1);
  }
  return {
    mode,
    ownerUid: input('owner-uid', '1000'),
    ownerGid: input('owner-gid', '1000'),
    extraPaths: input('extra-paths', ''),
  };
}

module.exports = { config, runScript };
