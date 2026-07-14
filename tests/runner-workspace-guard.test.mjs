// Regression suite for actions/runner-workspace-guard/action.yml
//
// This suite exists because the guard's ONLY job is to be right about file ownership,
// and a guard that is wrong about ownership is worse than no guard: it reports PASS over
// a poisoned workspace and the next deploy dies anyway. That is exactly the defect class
// the action was written to end (aws-operations: three weeks of green CI over a workspace
// that could not be checked out — see actions/runner-workspace-guard/action.yml).
//
// So the tests do not transcribe the shell. They EXTRACT the real `run:` blocks from the
// shipped action.yml and execute them under GitHub's exact shell invocation, against a
// real filesystem with real root-owned files.
//
// Every assertion is a MUTATION check: we never ask "did chown exit 0", we re-stat the
// files. A command that reports success is not evidence that the filesystem changed —
// that conflation is the whole reason the original defect survived for three weeks.
//
// PRIVILEGE MODEL: the suite needs to both (a) create root-owned files and (b) run the
// restore step as a NON-root user. It therefore works from either starting point:
//   * non-root + passwordless sudo (ubuntu-latest, where this normally runs) — elevate via sudo;
//   * root (a local WSL/root shell)                                          — drop via setpriv.
// If neither is possible the suite fails loudly rather than silently skipping; a skipped
// ownership test is indistinguishable from a passing one, and that is not acceptable here.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_BASH, extractRunScript } from './lib/workflow-step.mjs';

const ACTION = fileURLToPath(new URL('../actions/runner-workspace-guard/action.yml', import.meta.url));

const PREFLIGHT = extractRunScript(ACTION, 'Runner workspace preflight');
const RESTORE = extractRunScript(ACTION, 'Runner workspace restore');

const AM_ROOT = process.getuid() === 0;

// The uid/gid that plays the part of "the runner service user" (uid 1000 in production).
// When running as root we cannot use our own uid for that role — root is the *foreign*
// owner in this story — so we borrow 1000, exactly as on the real runner.
const OWNER_UID = AM_ROOT ? 1000 : process.getuid();
const OWNER_GID = AM_ROOT ? 1000 : process.getgid();

before(() => {
  if (!AM_ROOT) {
    const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' });
    assert.equal(
      probe.status,
      0,
      'this suite needs either root or passwordless sudo to create root-owned files; ' +
        'it must not be skipped — an ownership guard that is never tested against real ' +
        'root-owned files is not a guard.',
    );
  } else {
    assert.equal(
      spawnSync('setpriv', ['--help'], { encoding: 'utf8' }).status,
      0,
      'running as root requires setpriv(1) to drop privileges for the negative control',
    );
  }
});

/** Run a command with root privileges, from either starting point. */
function sudoExec(argv) {
  const r = AM_ROOT
    ? spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
    : spawnSync('sudo', argv, { encoding: 'utf8' });
  assert.equal(r.status, 0, `privileged command failed: ${argv.join(' ')}\n${r.stderr}`);
  return r;
}

/** Execute an extracted `run:` block under GitHub's exact shell invocation. */
function runStep(script, { workspace, extraPaths = '', asRoot }) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-step-'));
  const scriptPath = join(dir, 'step.sh');
  writeFileSync(scriptPath, script);
  sudoExec(['chmod', '0777', dir]);

  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GUARD_UID: String(OWNER_UID),
    GUARD_GID: String(OWNER_GID),
    GUARD_EXTRA_PATHS: extraPaths,
  };

  // Only the euid differs between these two. The shell OPTIONS stay exactly what GitHub
  // sets (--noprofile --norc -eo pipefail) in both cases — that is the point of reusing
  // GITHUB_BASH rather than inventing an invocation.
  //
  // The env is handed over via `sudo env KEY=VAL ...`, NOT `sudo -E`. sudo's env_reset
  // policy silently dropped GUARD_UID/GUARD_GID under `-E` on ubuntu-latest, and an empty
  // uid turns the action into a no-op that reports success (`chown ":" path` is a valid
  // do-nothing; `find -uid ""` errors to a zero count). The suite caught it; the action now
  // refuses an empty uid outright, and the harness no longer relies on sudo's goodwill.
  const envArgs = Object.entries({
    GITHUB_WORKSPACE: env.GITHUB_WORKSPACE,
    GUARD_UID: env.GUARD_UID,
    GUARD_GID: env.GUARD_GID,
    GUARD_EXTRA_PATHS: env.GUARD_EXTRA_PATHS,
  }).map(([k, v]) => `${k}=${v}`);

  let cmd, argv;
  if (asRoot) {
    if (AM_ROOT) { cmd = 'bash'; argv = [...GITHUB_BASH, scriptPath]; }
    else { cmd = 'sudo'; argv = ['env', ...envArgs, 'bash', ...GITHUB_BASH, scriptPath]; }
  } else {
    if (AM_ROOT) {
      cmd = 'setpriv';
      argv = [`--reuid=${OWNER_UID}`, `--regid=${OWNER_GID}`, '--clear-groups', 'bash', ...GITHUB_BASH, scriptPath];
    } else { cmd = 'bash'; argv = [...GITHUB_BASH, scriptPath]; }
  }

  const res = spawnSync(cmd, argv, { encoding: 'utf8', env });
  return { code: res.status, log: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** A workspace owned entirely by the "runner service user" — the healthy state. */
function cleanWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'guard-ws-'));
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(ws, '.git', 'index'), 'idx');
  writeFileSync(join(ws, '.claude', 'agents', 'scout.md'), '# scout');
  writeFileSync(join(ws, 'package.json'), '{}');
  sudoExec(['chown', '-R', `${OWNER_UID}:${OWNER_GID}`, ws]);
  assert.equal(statSync(ws).uid, OWNER_UID, 'precondition: workspace must start clean');
  return ws;
}

/** Make a path root-owned for real — exactly what a root container job does to the host. */
function poison(p) {
  sudoExec(['chown', '-R', 'root:root', p]);
  assert.equal(statSync(p).uid, 0, 'precondition: path must actually be root-owned');
}

/**
 * stat a path WITH privilege.
 *
 * Needed because a poisoned workspace is genuinely unreadable to us: mkdtemp creates the
 * root dir 0700, and once it is chowned to root the unprivileged test process cannot even
 * traverse into it — statSync on anything *inside* raises EACCES. That is the real
 * behaviour of the bug, so the test must not pretend otherwise; it must simply look at the
 * filesystem the way root can. (Running the suite as root hides this entirely, which is why
 * it only surfaced on ubuntu-latest. The unprivileged environment is the honest one.)
 */
function statAsRoot(p) {
  return sudoExec(['stat', '-c', '%u:%g', p]).stdout.trim();
}

// ---------------------------------------------------------------------------
// PREFLIGHT
// ---------------------------------------------------------------------------

test('preflight PASSES on a workspace owned by the runner service user', () => {
  const ws = cleanWorkspace();
  const { code, log } = runStep(PREFLIGHT, { workspace: ws, asRoot: true });
  assert.equal(code, 0, log);
  assert.match(log, /preflight PASSED/);
  assert.match(log, /ownership: OK/);
  assert.match(log, /deletability: OK/);
});

test('preflight PASSES when the workspace does not exist yet (first ever run on a runner)', () => {
  const { code, log } = runStep(PREFLIGHT, {
    workspace: join(tmpdir(), 'definitely-not-here-12345'),
    asRoot: true,
  });
  assert.equal(code, 0, log);
  assert.match(log, /nothing to inspect/);
});

test('preflight FAILS CLOSED on a root-poisoned workspace, naming the owner and the count', () => {
  const ws = cleanWorkspace();
  poison(join(ws, '.git')); // precisely what the container job did to aws-operations

  const { code, log } = runStep(PREFLIGHT, { workspace: ws, asRoot: true });

  assert.equal(code, 1, `preflight must fail closed on a poisoned workspace.\n${log}`);
  assert.match(log, /path\(s\) under .* are not owned by/);
  assert.match(log, /0:0/, 'must report root as the offending owner');
  assert.match(log, /::error::/, 'must emit an Actions error annotation');
  assert.match(log, /infrastructure fault, not a code fault/);
});

test('preflight catches an UNDELETABLE directory even when ownership looks correct', () => {
  // The invariant checkout actually needs is "can the service user write the PARENT",
  // which is NOT the same as "is the entry owned by the service user". A directory owned
  // by the right user but with the write bit off is invisible to an ownership-only check
  // — and still breaks checkout. This is why the guard checks deletability separately,
  // and this test is what stops someone "simplifying" that check away.
  const ws = cleanWorkspace();
  sudoExec(['chmod', '0555', join(ws, '.claude')]);

  const { code, log } = runStep(PREFLIGHT, { workspace: ws, asRoot: true });

  assert.equal(code, 1, `an unwritable directory must fail preflight.\n${log}`);
  assert.match(log, /NOT writable by/);
  assert.match(log, /ownership: OK/, 'ownership alone looked fine — that is exactly the point');
});

test('preflight reports a stale git lock as a WARNING and never deletes it', () => {
  const ws = cleanWorkspace();
  const lock = join(ws, '.git', 'index.lock');
  writeFileSync(lock, '');
  sudoExec(['chown', `${OWNER_UID}:${OWNER_GID}`, lock]);

  const { code, log } = runStep(PREFLIGHT, { workspace: ws, asRoot: true });

  assert.equal(code, 0, `a stale lock is not, by itself, a failure.\n${log}`);
  assert.match(log, /STALE git lock/);
  assert.ok(existsSync(lock), 'the guard must never delete a lock — it only reports');
});

// ---------------------------------------------------------------------------
// RESTORE
// ---------------------------------------------------------------------------

test('restore (as root) chowns a poisoned workspace back — PROVEN BY RE-STATTING, not by exit code', () => {
  const ws = cleanWorkspace();
  poison(ws);
  // Read the precondition with privilege: a poisoned 0700 root-owned workspace is, by
  // construction, one we cannot descend into. That is the bug, not a test artefact.
  assert.equal(statAsRoot(join(ws, '.git', 'index')), '0:0', 'precondition: poisoned');

  const { code, log } = runStep(RESTORE, { workspace: ws, asRoot: true });

  assert.equal(code, 0, log);
  assert.match(log, /restore PASSED/);

  // The actual proof. Not "chown said ok" — the files changed owner on disk. And these
  // statSync calls are deliberately UNPRIVILEGED: if the restore really worked, the
  // ordinary runner user can now read the workspace again. That is the whole invariant.
  for (const p of [ws, join(ws, '.git'), join(ws, '.git', 'index'), join(ws, '.claude', 'agents')]) {
    assert.equal(statSync(p).uid, OWNER_UID, `not restored (uid): ${p}`);
    assert.equal(statSync(p).gid, OWNER_GID, `not restored (gid): ${p}`);
  }
});

test('restore FAILS LOUDLY when it cannot restore (non-root against root-owned files)', () => {
  // THE NEGATIVE CONTROL. If this ever passes, the restore step is reporting success over
  // a workspace it did not actually fix — the original bug wearing a new hat.
  const ws = cleanWorkspace();
  poison(ws);

  const { code, log } = runStep(RESTORE, { workspace: ws, asRoot: false });

  assert.notEqual(code, 0, `restore must NOT report success while the workspace is still poisoned.\n${log}`);
  assert.match(log, /RESTORE (INCOMPLETE|FAILED)/);
  assert.equal(statSync(ws).uid, 0, 'and the workspace is genuinely still root-owned');
});

test('restore also covers extra-paths (the shared package store a root container writes)', () => {
  const ws = cleanWorkspace();
  const store = mkdtempSync(join(tmpdir(), 'guard-store-'));
  writeFileSync(join(store, 'blob'), 'x');
  poison(store);

  const { code, log } = runStep(RESTORE, { workspace: ws, extraPaths: store, asRoot: true });

  assert.equal(code, 0, log);
  assert.equal(statSync(join(store, 'blob')).uid, OWNER_UID, 'extra-path was not restored');
});

test('restore tolerates an absent extra-path rather than failing the job', () => {
  const ws = cleanWorkspace();
  const { code, log } = runStep(RESTORE, {
    workspace: ws,
    extraPaths: join(tmpdir(), 'not-here-98765'),
    asRoot: true,
  });
  assert.equal(code, 0, log);
});

// ---------------------------------------------------------------------------
// THE NO-OP HOLE  (a real defect this suite found, in CI, in the guard itself)
// ---------------------------------------------------------------------------

test('an EMPTY owner-uid must FAIL, not silently no-op into a false PASS', () => {
  // This is not a hypothetical. Under `sudo -E`, ubuntu-latest's env_reset dropped GUARD_UID,
  // and with an empty uid the restore step became a no-op that printed "restore PASSED":
  //   * `chown -R ":" <path>` is a VALID command that changes nothing and exits 0;
  //   * `find -uid ""` errors out, and an error-tolerant count reads that as ZERO offenders.
  // A guard that reports success over a workspace it never touched is the exact defect class
  // it was built to eliminate. Absent input is not safe input.
  for (const script of [PREFLIGHT, RESTORE]) {
    const ws = cleanWorkspace();
    poison(ws);

    const dir = mkdtempSync(join(tmpdir(), 'guard-noop-'));
    const scriptPath = join(dir, 'step.sh');
    writeFileSync(scriptPath, script);
    const res = spawnSync(
      AM_ROOT ? 'bash' : 'sudo',
      AM_ROOT
        ? [...GITHUB_BASH, scriptPath]
        : ['env', `GITHUB_WORKSPACE=${ws}`, 'GUARD_UID=', 'GUARD_GID=', 'GUARD_EXTRA_PATHS=', 'bash', ...GITHUB_BASH, scriptPath],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_WORKSPACE: ws, GUARD_UID: '', GUARD_GID: '', GUARD_EXTRA_PATHS: '' },
      },
    );
    const log = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.notEqual(res.status, 0, `an empty owner-uid must be refused outright.\n${log}`);
    assert.match(log, /must be a non-empty NUMERIC uid/);
    assert.doesNotMatch(log, /PASSED/, 'it must never print PASSED with no owner configured');
    assert.equal(statSync(ws).uid, 0, 'and it must not have pretended to fix anything');
  }
});

// ---------------------------------------------------------------------------
// HARNESS INTEGRITY
// ---------------------------------------------------------------------------

test('HARNESS INTEGRITY: the suite executes the SHIPPED action, and can observe a real failure', () => {
  // If this fails, the extractor is not reading the real action.yml and every other
  // assertion above is vacuous — passing over a script nobody ships.
  assert.match(PREFLIGHT, /preflight PASSED/, 'extracted preflight does not look like the shipped script');
  assert.match(RESTORE, /chown -R/, 'extracted restore does not look like the shipped script');
  assert.doesNotMatch(
    PREFLIGHT + RESTORE,
    /\$\{\{/,
    'run: blocks must be pure bash (inputs arrive via env:) so they are tested exactly as shipped',
  );

  // And prove the harness can actually observe a failure. A suite that cannot fail proves
  // nothing — NOT OBSERVABLE is not the same as PASS.
  const ws = cleanWorkspace();
  poison(ws);
  const { code } = runStep(PREFLIGHT, { workspace: ws, asRoot: true });
  assert.equal(code, 1, 'harness cannot observe a real failure — every other test here is meaningless');
});
