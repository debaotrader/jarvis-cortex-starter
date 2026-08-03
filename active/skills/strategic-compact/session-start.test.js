#!/usr/bin/env node
/**
 * Smoke + correctness tests for session-start.js
 * Run: node --test active/skills/strategic-compact/session-start.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.join(__dirname, 'session-start.js');

// Set JARVIS_CORTEX_ROOT so the hook finds inviolaveis.md in the repo
// (works in dev and CI; without this, CI has no ~/.claude/ symlink).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function runHook(stdin = '', env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, JARVIS_CORTEX_ROOT: REPO_ROOT, ...env }
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('[regression] getClaudeDir honors JARVIS_CORTEX_ROOT', () => {
  const { getClaudeDir } = require('./lib/utils');
  const fake = '/tmp/jarvis-cortex-fake';
  const orig = process.env.JARVIS_CORTEX_ROOT;
  process.env.JARVIS_CORTEX_ROOT = fake;
  try {
    assert.strictEqual(getClaudeDir(), fake);
  } finally {
    if (orig === undefined) delete process.env.JARVIS_CORTEX_ROOT;
    else process.env.JARVIS_CORTEX_ROOT = orig;
  }
});

test('[regression] getClaudeDir falls back to ~/.claude', () => {
  const { getClaudeDir } = require('./lib/utils');
  const orig = process.env.JARVIS_CORTEX_ROOT;
  delete process.env.JARVIS_CORTEX_ROOT;
  try {
    assert.strictEqual(getClaudeDir(), path.join(os.homedir(), '.claude'));
  } finally {
    if (orig !== undefined) process.env.JARVIS_CORTEX_ROOT = orig;
  }
});

test('[smoke] empty stdin does not crash', () => {
  const r = runHook('');
  assert.strictEqual(r.code, 0);
});

test('[smoke] malformed JSON stdin does not crash', () => {
  const r = runHook('not json {{{');
  assert.strictEqual(r.code, 0);
});

test('[smoke] missing inviolaveis.md exits cleanly', () => {
  // Point JARVIS_CORTEX_ROOT to a fresh temp dir with no inviolaveis.md
  const fakeRoot = path.join(os.tmpdir(), `session-start-test-${process.pid}`);
  fs.rmSync(fakeRoot, { recursive: true, force: true });
  fs.mkdirSync(fakeRoot, { recursive: true });
  try {
    const r = runHook('{}', { JARVIS_CORTEX_ROOT: fakeRoot, USERPROFILE: fakeRoot, HOME: fakeRoot });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout.trim(), '', 'should not inject when file is missing');
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test('[correctness] valid inviolaveis.md produces additionalContext with tier-1 rules', () => {
  const r = runHook(JSON.stringify({ session_id: 'abc', source: 'compact' }));
  assert.strictEqual(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /invioláveis|regras/i);
  assert.match(out.hookSpecificOutput.additionalContext, /padrao\.md/);
});
