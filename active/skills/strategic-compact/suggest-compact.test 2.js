#!/usr/bin/env node
/**
 * Smoke + correctness tests for suggest-compact.js
 * Run: node --test active/skills/strategic-compact/suggest-compact.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.join(__dirname, 'suggest-compact.js');
const TEST_SESSION = `test-${process.pid}-${Date.now()}`;
const COUNTER_FILE = path.join(os.tmpdir(), `claude-tool-count-${TEST_SESSION}`);

function runHook(stdin = '', env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_SESSION_ID: TEST_SESSION, ...env }
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

after(() => {
  try { fs.unlinkSync(COUNTER_FILE); } catch {}
});

test('[smoke] empty stdin does not crash', () => {
  try { fs.unlinkSync(COUNTER_FILE); } catch {}
  const r = runHook('');
  assert.strictEqual(r.code, 0);
});

test('[smoke] malformed JSON does not crash', () => {
  const r = runHook('not json');
  assert.strictEqual(r.code, 0);
});

test('[smoke] missing CLAUDE_SESSION_ID falls back to default', () => {
  const result = spawnSync(process.execPath, [HOOK], {
    input: '{}',
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_SESSION_ID: '' }
  });
  assert.strictEqual(result.status, 0);
});

test('[correctness] counter increments across invocations', () => {
  try { fs.unlinkSync(COUNTER_FILE); } catch {}
  runHook('{}');
  runHook('{}');
  runHook('{}');
  const val = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
  assert.strictEqual(val, 3);
});

test('[correctness] corrupted counter file resets to 1', () => {
  fs.writeFileSync(COUNTER_FILE, 'not a number');
  runHook('{}');
  const val = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
  assert.strictEqual(val, 1);
});
