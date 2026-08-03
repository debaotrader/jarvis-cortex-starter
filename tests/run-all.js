#!/usr/bin/env node
/**
 * tests/run-all.js — descobre e roda todos os *.test.js do cortex.
 *
 * Cobertura: active/rules/, active/skills/, codex/agent-skills/,
 * codex/skills-local/, tests/. Roda cada arquivo com `node --test`
 * (stdio inherit pra ver output ao vivo). Reporta summary no fim.
 * Exit 0 se todos passam, 1 se algum falha.
 *
 * Uso:
 *   node tests/run-all.js
 *   npm test
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  path.join(REPO_ROOT, 'active', 'rules'),
  path.join(REPO_ROOT, 'active', 'skills'),
  path.join(REPO_ROOT, 'codex', 'agent-skills'),
  path.join(REPO_ROOT, 'codex', 'skills-local'),
  path.join(REPO_ROOT, 'tests'),
];

function findTests(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const stat = fs.statSync(cur);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(cur)) {
        stack.push(path.join(cur, entry));
      }
    } else if (cur.endsWith('.test.js')) {
      out.push(cur);
    }
  }
  return out;
}

const tests = SCAN_DIRS.flatMap(findTests).sort();

if (tests.length === 0) {
  console.error('Nenhum *.test.js encontrado em:', SCAN_DIRS.join(', '));
  process.exit(1);
}

let pass = 0;
let fail = 0;
const start = Date.now();

for (const file of tests) {
  const rel = path.relative(REPO_ROOT, file);
  process.stdout.write(`\n--- ${rel} ---\n`);
  const result = spawnSync(process.execPath, ['--test', file], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (result.status === 0) pass++;
  else fail++;
}

const elapsed = Date.now() - start;
process.stdout.write(`\n=== ${pass}/${tests.length} passed, ${fail} failed, ${elapsed}ms ===\n`);
process.exit(fail === 0 ? 0 : 1);
