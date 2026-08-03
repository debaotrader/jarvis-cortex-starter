#!/usr/bin/env node
'use strict';

/**
 * Cursor PreToolUse adapter — RTK auto-rewrite for Shell.
 * Maps Cursor shell payloads into the Claude Bash shape that `rtk hook claude`
 * understands, then maps the rewrite back to Cursor's updated_input.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function toolName(input) {
  return String(input.tool_name || input.toolName || input.tool || '').trim();
}

function getCommand(input) {
  const ti = input.tool_input || input.toolInput || input.input || {};
  if (typeof ti.command === 'string') return ti.command;
  if (typeof input.command === 'string') return input.command;
  return null;
}

const raw = readStdin();
if (!raw.trim()) process.exit(0);

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const name = toolName(input);
const isShell = /^(Shell|Bash|shell|bash)$/i.test(name)
  || (input.hook_event_name === 'preToolUse' && typeof getCommand(input) === 'string')
  || typeof input.command === 'string';

const command = getCommand(input);
if (!isShell || typeof command !== 'string' || !command.trim()) {
  process.exit(0);
}

const claudePayload = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command },
});

const result = spawnSync('rtk', ['hook', 'claude'], {
  input: claudePayload,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});

if (result.error || result.status !== 0) {
  // Fail open for RTK — never block the agent if rewrite fails.
  process.exit(0);
}
if (!result.stdout.trim()) process.exit(0);

let output;
try {
  output = JSON.parse(result.stdout);
} catch {
  process.exit(0);
}

const updated = output?.hookSpecificOutput?.updatedInput?.command;
if (typeof updated !== 'string' || updated === command) {
  process.exit(0);
}

const response = {
  permission: 'allow',
  updated_input: {
    ...(input.tool_input || input.toolInput || input.input || {}),
    command: updated,
  },
  agent_message: 'RTK auto-rewrite aplicado ao comando shell.',
};

process.stdout.write(`${JSON.stringify(response)}\n`);
process.exit(0);
