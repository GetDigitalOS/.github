// Extract a step's `run:` script from a real workflow file and execute it under
// GitHub's EXACT shell invocation.
//
// The test must run the shipped script, not a copy of it. A transcribed copy
// proves only that the copy works — and the defect this suite exists to prevent
// (see deploy-railway-outcome-binding.test.mjs) lived precisely in the gap
// between what the script SAID it did and what the shell actually did.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// GitHub Actions expands `shell: bash` to exactly this. `-e` is set on the
// INVOCATION, so no `set` line inside the script can be relied on to clear it.
// Source: docs "Custom shell" / "Exit codes and error action preference".
export const GITHUB_BASH = ['--noprofile', '--norc', '-eo', 'pipefail'];

/**
 * Pull the `run:` block for a named step out of a workflow YAML.
 * Deliberately a small hand parser: it keeps the tests dependency-free, and it
 * reads the SAME bytes the runner will.
 */
export function extractRunScript(workflowPath, stepName) {
  const lines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);

  const stepIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (stepIdx === -1) {
    throw new Error(`step not found in ${workflowPath}: "${stepName}"`);
  }
  const stepIndent = lines[stepIdx].indexOf('-');

  // Find `run: |` inside this step (stop at the next step at the same indent).
  let runIdx = -1;
  for (let i = stepIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' ) continue;
    const indent = l.search(/\S/);
    if (indent <= stepIndent && l.trim().startsWith('- ')) break; // next step
    if (indent <= stepIndent && !l.trim().startsWith('#')) break; // left the step
    if (/^\s*run:\s*\|\s*$/.test(l)) { runIdx = i; break; }
  }
  if (runIdx === -1) throw new Error(`no "run: |" block in step "${stepName}"`);

  const runIndent = lines[runIdx].search(/\S/);
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.search(/\S/) <= runIndent) break; // block ended
    body.push(l);
  }
  while (body.length && body.at(-1) === '') body.pop();

  const dedent = Math.min(...body.filter((l) => l !== '').map((l) => l.search(/\S/)));
  return body.map((l) => (l === '' ? '' : l.slice(dedent))).join('\n') + '\n';
}

/**
 * Substitute `${{ ... }}` expressions. Throws on anything unmapped, so a new
 * expression in the workflow can never be silently left as a literal `${{ }}`
 * (which bash would happily treat as an empty-ish string and quietly pass).
 */
export function substitute(script, values) {
  return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    if (!(expr in values)) {
      throw new Error(`unmapped workflow expression: \${{ ${expr} }} — add it to the test's inputs`);
    }
    return String(values[expr]);
  });
}

/** Create a sandbox: stub CLIs on PATH, a simulated clock, a GITHUB_OUTPUT file. */
export function makeSandbox(tmpRoot, name) {
  const dir = join(tmpRoot, name);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'phase'), '');
  writeFileSync(join(dir, 'github_output'), '');

  // Simulated time. `sleep` is replaced by a shell FUNCTION (via BASH_ENV, which
  // --noprofile/--norc do not disable) that advances bash's own SECONDS and bumps
  // the phase counter the stubs read. This lets a 15-minute poll run instantly.
  //
  // It changes nothing about the shell OPTIONS under test: -e, -u and pipefail are
  // still exactly what GitHub sets. It only replaces the passage of time.
  writeFileSync(
    join(dir, 'preamble.sh'),
    [
      'sleep() {',
      '  SECONDS=$(( SECONDS + ${1%%.*} ))',
      '  printf "." >> "$SANDBOX/phase"',
      '}',
      '',
    ].join('\n'),
  );
  return { dir, bin, outputFile: join(dir, 'github_output') };
}

export function writeStub(sandbox, name, body) {
  const p = join(sandbox.bin, name);
  writeFileSync(p, body.startsWith('#!') ? body : `#!/usr/bin/env bash\n${body}`);
  chmodSync(p, 0o755);
}

/** Run an extracted script under GitHub's exact bash invocation. */
export function runStep(sandbox, script, env = {}) {
  const scriptPath = join(sandbox.dir, 'step.sh');
  writeFileSync(scriptPath, script);

  const res = spawnSync('bash', [...GITHUB_BASH, scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      BASH_ENV: join(sandbox.dir, 'preamble.sh'),
      SANDBOX: sandbox.dir,
      GITHUB_OUTPUT: sandbox.outputFile,
      ...env,
    },
  });

  const log = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const outputs = {};
  for (const line of readFileSync(sandbox.outputFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { code: res.status, log, outputs };
}
