#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const rtkBin = process.argv[2] || 'rtk';
const input = fs.readFileSync(0, 'utf8');
if (!input.trim()) process.exit(0);

const result = spawnSync(rtkBin, ['hook', 'claude'], {
  input,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});

if (result.error) {
  console.error(`rtk Codex hook failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}
if (!result.stdout.trim()) process.exit(0);

let output;
try {
  output = JSON.parse(result.stdout);
} catch (error) {
  console.error(`rtk Codex hook returned invalid JSON: ${error.message}`);
  process.exit(1);
}

const hookOutput = output?.hookSpecificOutput;
if (typeof hookOutput?.updatedInput?.command === 'string') {
  hookOutput.permissionDecision = 'allow';
}

process.stdout.write(`${JSON.stringify(output)}\n`);
