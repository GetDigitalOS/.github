// Regression suite for deploy-railway.yml's authoritative-outcome binding.
//
// THE DEFECT THIS EXISTS TO PREVENT
// --------------------------------
// The deploy step's whole purpose is to survive a non-zero `railway up` and go
// ask Railway what actually happened — the CLI is a TRANSPORT, Railway's
// deployment state is the AUTHORITY. It was written as:
//
//     shell: bash
//     run: |
//       set -uo pipefail     # adds -u and pipefail. Does NOT clear -e.
//       railway up $ARGS --ci
//       UP_EXIT=$?           # <-- unreachable when the CLI exits non-zero
//
// but GitHub expands `shell: bash` to `bash --noprofile --norc -eo pipefail {0}`,
// so `-e` is already ON. A non-zero `railway up` killed the shell ON THAT LINE —
// before UP_EXIT, before the warning, before the poll. audit-runner run
// 29292062216: the upload SUCCEEDED, the CLI's log-stream call then timed out and
// it exited 1, and the job went red over a deployment Railway had marked SUCCESS.
// The step that existed to ask Railway never asked.
//
// It passed review because under a plain `bash script.sh` the code is correct. So
// these tests run the REAL script, extracted from the REAL yaml, under GitHub's
// REAL invocation. Nothing here is transcribed; a revert fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractRunScript, substitute, makeSandbox, writeStub, runStep, GITHUB_BASH,
} from './lib/workflow-step.mjs';

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'deploy-railway.yml');
const TMP = mkdtempSync(join(tmpdir(), 'railway-wf-'));

const DEPLOY_STEP = 'Deploy to Railway (authoritative outcome)';
const VERIFY_STEP = 'Verify the deployed artifact reports the expected commit';

const DEPLOY_INPUTS = {
  'inputs.project-id': 'proj-abc',
  'inputs.service-name': 'audit-runner-api',
  'inputs.environment': 'production',
  'inputs.wait-for-deploy': 'true',
  'inputs.deploy-timeout-minutes': '15',
};

const OLD = [{ id: 'dep-old', status: 'SUCCESS' }];
const NEW_BUILDING = [{ id: 'dep-new', status: 'BUILDING' }];
const NEW_SUCCESS = [{ id: 'dep-new', status: 'SUCCESS', meta: { imageDigest: 'sha256:cafe' } }];
const NEW_FAILED = [{ id: 'dep-new', status: 'FAILED' }];

// The `railway` stub models the REAL failure mode: `up` prints its upload chatter
// and succeeds at uploading, then exits non-zero anyway (the log stream died).
const RAILWAY_STUB = `
sub="$1"; shift
phase=$(wc -c < "$SANDBOX/phase" | tr -d ' ')
case "$sub" in
  up)
    echo "Indexing..."; echo "Uploading..."; echo "CI mode enabled"
    if [ "\${RAILWAY_UP_EXIT:-0}" -ne 0 ]; then
      echo "reqwest error: operation timed out" >&2   # upload landed; stream died
    fi
    exit "\${RAILWAY_UP_EXIT:-0}"
    ;;
  deployment)
    if [ -n "\${LIST_FAILS_THROUGH_PHASE:-}" ] && [ "$phase" -le "\${LIST_FAILS_THROUGH_PHASE}" ]; then
      echo "railway: network error" >&2
      exit 1
    fi
    exec node -e '
      const fs = require("fs");
      const tl = JSON.parse(fs.readFileSync(process.env.TIMELINE, "utf8"));
      process.stdout.write(JSON.stringify(tl[Math.min(Number(process.argv[1]), tl.length - 1)]));
    ' "$phase"
    ;;
  logs) exit "\${RAILWAY_LOGS_EXIT:-0}" ;;
esac
`;

function deploySandbox(name, timeline) {
  const sb = makeSandbox(TMP, name);
  writeStub(sb, 'railway', RAILWAY_STUB);
  const tl = join(sb.dir, 'timeline.json');
  writeFileSync(tl, JSON.stringify(timeline));
  sb.timeline = tl;
  return sb;
}

function runDeploy(sb, env) {
  const script = substitute(extractRunScript(WORKFLOW, DEPLOY_STEP), DEPLOY_INPUTS);
  return runStep(sb, script, { DEPLOY_TOKEN: 'tok', TIMELINE: sb.timeline, ...env });
}

// ── 0. Harness integrity ────────────────────────────────────────────────────
// If this ever passes, the harness is NOT reproducing GitHub's shell and every
// other test below is vacuous. It asserts the bug is reproducible on demand.
test('harness: GitHub\'s `shell: bash` kills the script before a bare `$?` read', () => {
  const sb = makeSandbox(TMP, 'harness');
  const broken = 'set -uo pipefail\necho START\nfalse\nEXIT=$?\necho "HANDLER REACHED exit=$EXIT"\n';
  const r = runStep(sb, broken);

  assert.equal(r.code, 1, 'errexit must kill it');
  assert.match(r.log, /START/);
  assert.doesNotMatch(r.log, /HANDLER REACHED/, 'the exact defect: the handler after a non-zero command is unreachable');
  assert.deepEqual(GITHUB_BASH, ['--noprofile', '--norc', '-eo', 'pipefail']);
});

// ── 1. THE FIX ──────────────────────────────────────────────────────────────
test('non-zero `railway up` + new deployment + Railway SUCCESS => step is GREEN', () => {
  const sb = deploySandbox('t1', [OLD, NEW_BUILDING, NEW_SUCCESS]);
  const r = runDeploy(sb, { RAILWAY_UP_EXIT: '1' });

  // The handler was REACHED — this single assertion is the whole defect.
  assert.match(r.log, /::warning::.*railway up.*exited 1/, 'the UP_EXIT handler must run');
  assert.match(r.log, /NOT authoritative/, 'the non-authoritative warning must print');

  // ...and the step then went and asked Railway, and believed Railway.
  assert.match(r.log, /previous deployment: dep-old/);
  assert.match(r.log, /Railway deployment SUCCESS/);
  assert.equal(r.code, 0, 'authoritative SUCCESS makes the step green despite the non-zero CLI');
  assert.equal(r.outputs.outcome, 'success');
  assert.equal(r.outputs['deployment-id'], 'dep-new', 'must bind to the NEW deployment, not the previous one');
  assert.equal(r.outputs['final-state'], 'SUCCESS');
  assert.equal(r.outputs['image-digest'], 'sha256:cafe');
});

// ── 2. Negative control: nothing was handed to Railway ───────────────────────
test('non-zero `railway up` + NO new deployment registers => step FAILS (upload-failed)', () => {
  const sb = deploySandbox('t2', [OLD]); // never advances past the old deployment
  const r = runDeploy(sb, { RAILWAY_UP_EXIT: '1' });

  assert.equal(r.code, 1, 'a genuine upload failure must still fail the job');
  assert.equal(r.outputs.outcome, 'upload-failed');
  assert.match(r.log, /UPLOAD FAILED/);
  assert.match(r.log, /Nothing was handed to Railway/);
});

// ── 3. Negative control: Railway itself says it failed ──────────────────────
test('non-zero `railway up` + Railway terminal FAILED => step FAILS (deploy-failed)', () => {
  const sb = deploySandbox('t3', [OLD, NEW_FAILED]);
  // The log-tailing fallback also exits non-zero; `|| true` must keep it non-fatal
  // so we still reach finish() and report the real outcome.
  const r = runDeploy(sb, { RAILWAY_UP_EXIT: '1', RAILWAY_LOGS_EXIT: '1' });

  assert.equal(r.code, 1);
  assert.equal(r.outputs.outcome, 'deploy-failed');
  assert.equal(r.outputs['final-state'], 'FAILED');
  assert.match(r.log, /Railway deployment FAILED/);
});

// ── 4. Positive control: the happy path is unchanged ────────────────────────
test('successful `railway up` + authoritative SUCCESS => GREEN, and no warning is emitted', () => {
  const sb = deploySandbox('t4', [OLD, NEW_SUCCESS]);
  const r = runDeploy(sb, { RAILWAY_UP_EXIT: '0' });

  assert.equal(r.code, 0);
  assert.equal(r.outputs.outcome, 'success');
  assert.doesNotMatch(r.log, /NOT authoritative/, 'a clean deploy must not cry wolf');
});

// ── 5. The same class of bug, on the STATE READ ─────────────────────────────
// `latest_field` pipes the CLI into node. With pipefail + errexit, a transient CLI
// failure inside `PREV_ID="$(latest_field id)"` would kill the step — i.e. failing
// to READ the state would fail the DEPLOY. Absence of an answer must mean "unknown".
test('a transient `railway deployment list` failure does not kill the step', () => {
  const sb = deploySandbox('t5', [OLD, NEW_SUCCESS]);
  const r = runDeploy(sb, { RAILWAY_UP_EXIT: '0', LIST_FAILS_THROUGH_PHASE: '0' });

  assert.match(r.log, /previous deployment: none/, 'an unreadable state reads as unknown, not as a crash');
  assert.equal(r.code, 0);
  assert.equal(r.outputs.outcome, 'success');
});

// ── 6-9. LAYER 2 — the provenance poll, same defect class ───────────────────
// This step has NEVER executed in production: it is skipped whenever the deploy
// step fails, and the deploy step failed every time Layer 2 would have mattered.
// `BODY="$(curl ...)"` under errexit dies on the FIRST refused connection — which
// is exactly what a container swap produces and exactly what the loop exists to
// ride out. The poll would not poll.
const VERIFY_INPUTS = { 'inputs.service-name': 'audit-runner-api' };
const SHA = 'b816175db742931a0fef99a10b91c26c2d830e37';
const OLD_SHA = '0000000000000000000000000000000000000000';

const CURL_STUB = `
phase=$(wc -c < "$SANDBOX/phase" | tr -d ' ')
exec node -e '
  const fs = require("fs");
  const rs = JSON.parse(fs.readFileSync(process.env.RESPONSES, "utf8"));
  const r = rs[Math.min(Number(process.argv[1]), rs.length - 1)];
  if (r.exit) process.exit(r.exit);
  process.stdout.write(JSON.stringify(r.body));
' "$phase"
`;

function runVerify(name, responses, env = {}) {
  const sb = makeSandbox(TMP, name);
  writeStub(sb, 'curl', CURL_STUB);
  const rf = join(sb.dir, 'responses.json');
  writeFileSync(rf, JSON.stringify(responses));
  const script = substitute(extractRunScript(WORKFLOW, VERIFY_STEP), VERIFY_INPUTS);
  return runStep(sb, script, {
    RESPONSES: rf,
    VERIFY_URL: 'https://svc.example/api/version',
    EXPECTED_SHA: SHA,
    TIMEOUT_S: '180',
    ...env,
  });
}

test('layer 2: rides out a refused connection during the container swap, then verifies', () => {
  const r = runVerify('t6', [
    { exit: 7 },                                          // connection refused mid-swap
    { body: { buildSha: OLD_SHA, identified: true } },    // old container still answering
    { body: { buildSha: SHA, identified: true } },        // new build is live
  ]);

  assert.equal(r.code, 0, 'the first refused connection must not kill the poll');
  assert.match(r.log, /PROVENANCE VERIFIED/);
});

test('layer 2: `identified: false` is a FAILURE, never a pass', () => {
  const r = runVerify('t7', [{ body: { buildSha: 'unknown', identified: false } }]);

  assert.equal(r.code, 1);
  assert.match(r.log, /CANNOT IDENTIFY ITSELF/);
});

test('layer 2: the old SHA still serving is a REVISION MISMATCH', () => {
  const r = runVerify('t8', [{ body: { buildSha: OLD_SHA, identified: true } }], { TIMEOUT_S: '30' });

  assert.equal(r.code, 1);
  assert.match(r.log, /REVISION MISMATCH/);
});

test('layer 2: an endpoint that never answers fails as "no response", not as a mismatch', () => {
  const r = runVerify('t9', [{ exit: 7 }], { TIMEOUT_S: '30' });

  assert.equal(r.code, 1);
  assert.match(r.log, /No response from/);
  assert.doesNotMatch(r.log, /REVISION MISMATCH/, 'never-answered and wrong-SHA are different facts');
});
