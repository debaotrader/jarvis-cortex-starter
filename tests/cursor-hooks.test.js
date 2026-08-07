#!/usr/bin/env node
/**
 * tests/cursor-hooks.test.js — adapter behavior for Cursor enforce/RTK hooks.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENFORCE = path.join(REPO_ROOT, 'cursor', 'hooks', 'enforce-cursor.js');
const RTK = path.join(REPO_ROOT, 'cursor', 'hooks', 'rtk-shell.js');

// The adapter spawns enforce.js, which logs to getClaudeDir(). Without an
// override that is the owner's real ~/.claude/debug/enforce.log, so every
// deny in this suite appended a synthetic record to the actual audit
// trail. Default to a throwaway root and clean it up.
const SUITE_ROOT = require('node:fs').mkdtempSync(
  path.join(require('node:os').tmpdir(), 'jarvis-cursor-suite-'),
);
process.on('exit', () => {
  try {
    require('node:fs').rmSync(SUITE_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
});


// Force the throwaway root. `env: options.env || …` was not enough: an
// override that spreads process.env carries a legitimately configured
// JARVIS_CORTEX_ROOT straight through, and those children then write to
// the REAL audit log. Two rounds of "audited per line, zero spawn sites
// without env" missed this, because the defect is not a missing env — it
// is a present env carrying the wrong root through.
//
// Three cases, in order:
//   1. the test supplied its OWN root (one that differs from the ambient
//      value) — it wants to read that log back, so honour it;
//   2. the test isolates via HOME instead — strip any inherited root so
//      the HOME fallback in getClaudeDir()/getCodexDir() actually applies;
//   3. everything else — force SUITE_ROOT.
function childEnv(options = {}) {
  const ambient = process.env.JARVIS_CORTEX_ROOT;
  if (!options.env) return { ...process.env, JARVIS_CORTEX_ROOT: SUITE_ROOT };
  const env = { ...options.env };
  if (env.JARVIS_CORTEX_ROOT && env.JARVIS_CORTEX_ROOT !== ambient) return env;
  if (env.HOME && env.HOME !== process.env.HOME) {
    delete env.JARVIS_CORTEX_ROOT;
    return env;
  }
  return { ...env, JARVIS_CORTEX_ROOT: SUITE_ROOT };
}

function runHook(script, payload) {
  return spawnSync(process.execPath, [script], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: childEnv(),
  });
}

test('[cursor-hooks] invalid JSON → deny', () => {
  const r = runHook(ENFORCE, 'not-json');
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
});

test('[cursor-hooks] Write .env → deny (mapped from enforce ask)', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/tmp/.env', contents: 'SECRET=1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
  assert.match(out.user_message || '', /\.env|protegido|protected/i);
});

test('[cursor-hooks] safe Write → allow JSON (failClosed requires stdout)', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/tmp/safe.ts', contents: 'ok' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'allow');
});

test('[cursor-hooks] beforeShellExecution dangerous rm → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    command: 'rm -rf /',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
});

test('[cursor-hooks] MCP targeting .env → deny (tool_input JSON string)', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution',
    tool_name: 'MCP: evil/write_file',
    tool_input: JSON.stringify({ path: '/project/.env' }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
});

test('[cursor-hooks] MCP tool_input string inválida → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution',
    tool_name: 'MCP: evil/write_file',
    tool_input: '{not-json',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
});
// === A3: fail-closed defaults ===
// permissions.json runs approvalMode "unrestricted" with
// terminalAllowlist ["*"], so this hook is the only gate in Cursor.
// "unknown tool → allow" meant an upstream tool rename would disable
// enforcement silently.

test('[cursor-hooks] unknown tool name → deny (fail-closed default)', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'preToolUse',
    tool_name: 'SomeNewCursorTool',
    tool_input: { path: '/etc/hosts' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
  // The name is no longer reflected — it is hashed. An operator who
  // suspects a tool can hash that candidate and compare, which confirms a
  // hypothesis without the hook ever emitting the value.
  assert.ok(!r.stdout.includes('SomeNewCursorTool'),
    `tool name reflected: ${r.stdout}`);
  const nameHash = require('node:crypto').createHash('sha256')
    .update('SomeNewCursorTool').digest('hex').slice(0, 12);
  assert.match(out.agent_message || '', new RegExp(`name_sha256_12=${nameHash}`),
    'the hash must identify the tool without reflecting it');
});

test('[cursor-hooks] shell event without command → deny (fail-closed)', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: {},
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
});

test('[cursor-hooks] shell event with empty command → allow (validated, nothing runs)', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow');
});

test('[cursor-hooks] read-only tools still allowed (deny default must not brick Cursor)', () => {
  for (const tool_name of ['Read', 'read_file', 'Glob', 'grep_search', 'codebase_search', 'list_dir']) {
    const r = runHook(ENFORCE, {
      hook_event_name: 'preToolUse',
      tool_name,
      tool_input: { path: '/etc/hosts' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'allow', `${tool_name} must be allowed`);
  }
});

test('[cursor-hooks] process.env grep → deny (accepted cost of the permissive pattern)', () => {
  // The pattern was reverted to permissive, so this asks in enforce.js
  // and the adapter correctly maps any non-allow to deny. Documented
  // cost, not a bug — see the KNOWN LIMITATION block in enforce.js.
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: 'grep -rn process.env tests/' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] cat .env → deny (real secret access still blocked)', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: 'cat .env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
  assert.match(out.user_message || '', /\.env/);
});

// === A3 repair cycle 1: every input shape that can reach allow() ===

test('[cursor-hooks] shell-variable .env path → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: 'D=/project/; echo x > $D.env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] Write to prod.env (no leading dot) → deny', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/project/prod.env', contents: 'SECRET=1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] every malformed top-level payload emits JSON and denies', () => {
  // failClosed treats empty stdout as hook failure; an uncaught throw
  // used to exit 1 with zero stdout on `null`.
  for (const payload of ['null', '5', '"str"', '[]', 'true', '']) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, `exit 0 expected for ${payload || '(empty)'}: ${r.stderr}`);
    assert.ok(r.stdout.trim(), `stdout must not be empty for ${payload || '(empty)'}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.permission, 'deny', `deny expected for ${payload || '(empty)'}`);
  }
});

test('[cursor-hooks] mutation tool without a usable path → deny', () => {
  const SHAPES = [
    { tool_name: 'Write' },
    { tool_name: 'Write', tool_input: 'oops' },
    { tool_name: 'Write', tool_input: [] },
    { tool_name: 'Write', tool_input: 5 },
    { tool_name: 'Edit', tool_input: {} },
    { tool_name: 'Delete', tool_input: { path: '' } },
    { tool_name: 'StrReplace', tool_input: { path: 42 } },
  ];
  for (const payload of SHAPES) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(payload)}`);
  }
});

test('[cursor-hooks] non-object MCP payload → deny', () => {
  for (const tool_input of [[1, 2], 5, null, true, '[]']) {
    const r = runHook(ENFORCE, {
      hook_event_name: 'beforeMCPExecution',
      tool_name: 'MCP: evil/write_file',
      tool_input,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for MCP tool_input ${JSON.stringify(tool_input)}`);
  }
});

test('[cursor-hooks] MCP with no arguments is still validated and allowed', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution',
    tool_name: 'MCP: graphify/query',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow');
});

test('[cursor-hooks] allowlist does not leak to punctuation variants', () => {
  for (const tool_name of ['Read.File', 'Read-File', 'read__file', 'Rea d']) {
    const r = runHook(ENFORCE, {
      hook_event_name: 'preToolUse', tool_name, tool_input: { path: '/x' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `${tool_name} must not inherit allowlist trust`);
  }
});

test('[cursor-hooks] mutation-capable tools are not on the read-only allowlist', () => {
  for (const tool_name of ['todo_write', 'TodoWrite', 'create_diagram']) {
    const r = runHook(ENFORCE, {
      hook_event_name: 'preToolUse', tool_name, tool_input: {},
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `${tool_name} is mutation-capable and must not be allowlisted as read-only`);
  }
});

// === A3 repair cycle 2: one red test per individual source change ===

test('[cursor-hooks] conflicting destination aliases → deny (no shadowing)', () => {
  // A safe `path` parked next to a protected `file_path`: validating
  // only the first-present alias lets the caller choose what gets
  // checked while the runtime may act on the other.
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/tmp/safe.txt', file_path: '/project/prod.env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] every supplied destination is validated, order-independent', () => {
  for (const tool_input of [
    { path: '/project/.env', file_path: '/tmp/safe.txt' },
    { file_path: '/tmp/safe.txt', path: '/project/.env' },
    { path: '/tmp/safe.txt', uri: 'file:///project/.env' },
    { target_file: '/project/prod.env', path: '/tmp/safe.txt' },
  ]) {
    const r = runHook(ENFORCE, { tool_name: 'Write', tool_input });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(tool_input)}`);
  }
});

test('[cursor-hooks] conflicting tool_name aliases → deny', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Read', toolName: 'Write', tool_input: { path: '/project/.env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] conflicting tool_input aliases → deny', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/tmp/safe.txt' },
    toolInput: { path: '/project/.env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] agreeing aliases are not treated as a conflict', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Write', toolName: 'Write',
    tool_input: { path: '/tmp/safe.ts', file_path: '/tmp/safe.ts', contents: 'ok' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow');
});

test('[cursor-hooks] explicitly blank MCP tool_input → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution', tool_name: 'MCP: x/y', tool_input: '   ',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] deeply nested payload denies with JSON, never bare exit 1', () => {
  const N = 20000;
  const payload = '{"hook_event_name":"beforeMCPExecution","tool_name":"MCP: x/y","tool_input":{"deep":'
    + '{"a":'.repeat(N) + '1' + '}'.repeat(N) + '}}';
  const r = runHook(ENFORCE, payload);
  assert.strictEqual(r.status, 0, `must not crash: ${r.stderr.slice(0, 200)}`);
  assert.ok(r.stdout.trim(), 'stdout must not be empty under failClosed');
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] oversized payload → deny', () => {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { path: '/tmp/safe.txt', blob: 'x'.repeat(600 * 1024) },
  });
  const r = runHook(ENFORCE, payload);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] decision-less enforce output → deny', () => {
  // Stub a cortex layout so resolveEnforce() picks up a fake enforce
  // that emits valid JSON carrying no decision field.
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cursor-stub-'));
  try {
    fs.mkdirSync(path.join(dir, 'cursor', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'active', 'rules'), { recursive: true });
    fs.copyFileSync(ENFORCE, path.join(dir, 'cursor', 'hooks', 'enforce-cursor.js'));
    fs.writeFileSync(
      path.join(dir, 'active', 'rules', 'enforce.js'),
      'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse"}}));\n',
    );
    const r = runHook(path.join(dir, 'cursor', 'hooks', 'enforce-cursor.js'), {
      tool_name: 'Write', tool_input: { path: '/tmp/safe.txt' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// === A3 repair cycle 3 ===

test('[cursor-hooks] conflicting hook_event_name aliases → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    hookEventName: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] conflicting command aliases → deny', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
    command: 'cat .env',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[cursor-hooks] agreeing command aliases still allowed', () => {
  const r = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution',
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
    command: 'ls',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow');
});

test('[cursor-hooks] non-string tool_name / hook_event_name → deny', () => {
  const SHAPES = [
    { tool_name: ['Read'], tool_input: { path: '/project/.env' } },
    { tool_name: 5, tool_input: {} },
    { tool_name: { a: 1 }, tool_input: {} },
    { hook_event_name: ['beforeMCPExecution'], tool_name: 'MCP: x/y', tool_input: {} },
    { hook_event_name: 7, tool_name: 'Shell', tool_input: { command: 'ls' } },
  ];
  for (const payload of SHAPES) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(payload)}`);
  }
});

test('[cursor-hooks] alias equality is key-order independent', () => {
  // `{path,contents}` vs `{contents,path}` are the same object; a
  // stringify comparison called them conflicting and denied.
  const r = runHook(ENFORCE, {
    tool_name: 'Write',
    tool_input: { path: '/tmp/a.ts', contents: 'x' },
    toolInput: { contents: 'x', path: '/tmp/a.ts' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow');
});

test('[cursor-hooks] huge reflected tool_name still emits complete valid JSON', () => {
  // 400 kB name: the reply exceeded the pipe buffer and process.exit
  // dropped the tail, so Cursor got truncated unparseable JSON.
  const r = runHook(ENFORCE, {
    hook_event_name: 'preToolUse',
    tool_name: 'X'.repeat(400000),
    tool_input: {},
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);   // throws if truncated
  assert.strictEqual(out.permission, 'deny');
  assert.ok(r.stdout.length < 4096, `reflected field must be bounded, got ${r.stdout.length}`);
});

test('[cursor-hooks] encoded destinations are decoded before validation', () => {
  // file:///project/%2Eenv and /project/.env are the same target. The
  // encoded spelling used to win.
  const ENCODED = [
    { uri: 'file:///project/%2Eenv' },
    { uri: 'file:///project/%2eenv' },
    { uri: 'file:///project/%252Eenv' },
    { uri: 'file:///project/.env' },
    { path: '/project/%2Eenv' },
    { path: '/project/%252eenv' },
    { path: '/project/%2Eenv%2Elocal' },
  ];
  for (const tool_input of ENCODED) {
    const r = runHook(ENFORCE, { tool_name: 'Write', tool_input });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `encoded .env must deny: ${JSON.stringify(tool_input)}`);
  }
});

test('[cursor-hooks] decoding does not over-block ordinary encoded paths', () => {
  for (const tool_input of [
    { path: '/project/my%20report.txt' },
    { uri: 'file:///project/notes%2Emd' },
  ]) {
    const r = runHook(ENFORCE, { tool_name: 'Write', tool_input });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'allow',
      `must not over-block: ${JSON.stringify(tool_input)}`);
  }
});

test('[cursor-hooks] MCP call without a usable tool name → deny', () => {
  for (const payload of [
    { hook_event_name: 'beforeMCPExecution', tool_input: { a: 1 } },
    { hook_event_name: 'beforeMCPExecution', tool_name: '   ', tool_input: { a: 1 } },
    { hook_event_name: 'beforeMCPExecution', tool_name: '', tool_input: { a: 1 } },
  ]) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(payload)}`);
  }
});

test('[cursor-hooks] blank supplied tool_name is rejected, absent stays routable', () => {
  const blank = runHook(ENFORCE, { tool_name: '   ', tool_input: { path: '/tmp/x.txt' } });
  assert.strictEqual(JSON.parse(blank.stdout).permission, 'deny');
  // Absent name on a shell event is legitimate — the event routes it.
  const shell = runHook(ENFORCE, {
    hook_event_name: 'beforeShellExecution', tool_input: { command: 'ls' },
  });
  assert.strictEqual(JSON.parse(shell.stdout).permission, 'allow');
});

test('[cursor-hooks] event and tool_name must agree', () => {
  // Branch order used to decide: the shell test ran before the MCP
  // event test, so a beforeMCPExecution payload named Shell took the
  // shell path — command validated, protected path never seen.
  const MISMATCHED = [
    { hook_event_name: 'beforeMCPExecution', tool_name: 'Shell',
      tool_input: { command: 'ls', path: '/project/.env' } },
    { hook_event_name: 'beforeMCPExecution', tool_name: 'Write',
      tool_input: { path: '/project/.env' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'mcp__x__y',
      tool_input: { command: 'ls' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Write',
      tool_input: { command: 'ls' } },
  ];
  for (const payload of MISMATCHED) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `mismatched event/name must deny: ${JSON.stringify(payload)}`);
  }
});

test('[cursor-hooks] matching event/name combinations still route normally', () => {
  const OK = [
    [{ hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'ls' } }, 'allow'],
    [{ hook_event_name: 'beforeShellExecution', tool_input: { command: 'ls' } }, 'allow'],
    [{ tool_name: 'Shell', tool_input: { command: 'ls' } }, 'allow'],
    [{ hook_event_name: 'beforeMCPExecution', tool_name: 'mcp__g__query', tool_input: {} }, 'allow'],
    [{ hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'cat .env' } }, 'deny'],
  ];
  for (const [payload, want] of OK) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(JSON.parse(r.stdout).permission, want,
      `${JSON.stringify(payload)} expected ${want}`);
  }
});

test('[cursor-hooks] names made only of invisible characters → deny', () => {
  const C = n => String.fromCharCode(n);
  const INVISIBLE = [C(0x00), C(0x1b), C(0x85), C(0x9b), C(0x200b), C(0xfeff), C(0x200d) + C(0x200c)];
  for (const bad of INVISIBLE) {
    const mcp = runHook(ENFORCE, {
      hook_event_name: 'beforeMCPExecution', tool_name: bad, tool_input: { a: 1 },
    });
    assert.strictEqual(JSON.parse(mcp.stdout).permission, 'deny',
      `invisible MCP name must deny: U+${bad.codePointAt(0).toString(16)}`);
    const pre = runHook(ENFORCE, { tool_name: bad, tool_input: { path: '/tmp/x.txt' } });
    assert.strictEqual(JSON.parse(pre.stdout).permission, 'deny',
      `invisible tool name must deny: U+${bad.codePointAt(0).toString(16)}`);
  }
});

test('[cursor-hooks] rtk-shell rewrites ls → rtk ls', () => {
  const r = runHook(RTK, {
    tool_name: 'Shell',
    tool_input: { command: 'ls' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'allow');
  assert.strictEqual(out.updated_input.command, 'rtk ls');
});

// === A3 (H2): event authority must not turn on exact spelling ===
// The event/name compatibility check compared `event === 'beforeShell
// Execution'` and `event === 'beforeMCPExecution'` exactly, against a
// string the caller controls. One capital away from canonical, neither
// test fired, routing fell back to the tool name, and the payload chose
// its own branch.

test('[a3-h2] near-miss event spelling cannot buy a softer branch', () => {
  // `BeforeMCPExecution` + `Shell` used to reach allow: the shell branch
  // validated `command` and never looked at `path`. Both fields are in
  // the payload; only one of them was ever checked.
  const r = runHook(ENFORCE, {
    hook_event_name: 'BeforeMCPExecution',
    tool_name: 'Shell',
    tool_input: { command: 'ls', path: '/project/.env' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
});

test('[a3-h2] every case variant of a known event carries the same authority', () => {
  // Each pair is (event spelling, tool name) that must be refused as
  // incompatible. Under exact-match comparison every one of these
  // reached allow.
  const MISMATCHED = [
    ['BeforeMCPExecution', 'Shell', { command: 'ls', path: '/project/.env' }],
    ['beforemcpexecution', 'Shell', { command: 'ls', path: '/project/.env' }],
    ['BEFOREMCPEXECUTION', 'Shell', { command: 'ls', path: '/project/.env' }],
    ['BeforeMcpExecution', 'bash', { command: 'ls', path: '/project/.env' }],
    ['BEFORESHELLEXECUTION', 'mcp__x__y', { command: 'ls' }],
    ['BeforeShellExecution', 'mcp__x__y', { command: 'ls' }],
    ['beforeshellexecution', 'MCP: evil/write_file', { command: 'ls' }],
  ];
  for (const [hook_event_name, tool_name, tool_input] of MISMATCHED) {
    const r = runHook(ENFORCE, { hook_event_name, tool_name, tool_input });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `${hook_event_name} + ${tool_name} must be refused as incompatible`);
  }
});

test('[a3-h2] case-folded events still route their own legitimate traffic', () => {
  // Recognising a spelling must grant the branch too, not only the
  // refusal — otherwise the fix would just be a blanket deny.
  const OK = [
    [{ hook_event_name: 'BeforeShellExecution', tool_name: 'Shell', tool_input: { command: 'ls' } }, 'allow'],
    [{ hook_event_name: 'BEFORESHELLEXECUTION', tool_name: 'Shell', tool_input: { command: 'cat .env' } }, 'deny'],
    [{ hook_event_name: 'BeforeMCPExecution', tool_name: 'mcp__g__query', tool_input: {} }, 'allow'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', contents: 'ok' } }, 'allow'],
    [{ hook_event_name: 'BeforeShellExecution', tool_input: { command: 'ls' } }, 'allow'],
  ];
  for (const [payload, want] of OK) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).permission, want,
      `${JSON.stringify(payload)} expected ${want}`);
  }
});

test('[a3-h2] an unrecognised event grants no authority and does not brick routing', () => {
  // Deliberate asymmetry: an event we do not know is not an error, it is
  // simply not authoritative. Denying unknown spellings would mean that
  // if Cursor ever spells the preToolUse payload differently from its
  // registration key, every Write and Edit hard-fails. Routing falls
  // back to the tool name, whose branches validate their own inputs and
  // whose default is deny.
  const shell = runHook(ENFORCE, {
    hook_event_name: 'bogusEvent', tool_name: 'Shell', tool_input: { command: 'cat .env' },
  });
  assert.strictEqual(JSON.parse(shell.stdout).permission, 'deny',
    'name-based routing must still validate the command');

  const safe = runHook(ENFORCE, {
    hook_event_name: 'bogusEvent', tool_name: 'Shell', tool_input: { command: 'ls' },
  });
  assert.strictEqual(JSON.parse(safe.stdout).permission, 'allow',
    'an unknown event must not blanket-deny ordinary traffic');

  const unmapped = runHook(ENFORCE, {
    hook_event_name: 'bogusEvent', tool_name: 'SomeNewCursorTool', tool_input: { path: '/x' },
  });
  const unmappedOut = JSON.parse(unmapped.stdout);
  assert.strictEqual(unmappedOut.permission, 'deny');
  // The supplied spelling is hashed rather than echoed; the hash still
  // distinguishes it from the canonical events.
  const eventHash = require('node:crypto').createHash('sha256')
    .update('bogusEvent').digest('hex').slice(0, 12);
  assert.ok(!unmapped.stdout.includes('bogusEvent'),
    `event spelling reflected: ${unmapped.stdout}`);
  assert.match(unmappedOut.agent_message || '', new RegExp(`event_sha256_12=${eventHash}`),
    'the diagnostic must identify the spelling the payload sent, by hash');
});

// === A3 (H1/H3 parity pins for the Cursor adapter) ===
// enforce-cursor.js already refuses non-string and blank names, already
// refuses array top levels, and already defaults to deny for anything
// unmapped. Neither H1 nor H3 is a reachable bypass here. Pinned so the
// twin cannot regress into the shape the other two files had.

test('[a3-h1] a nameless payload never reaches allow unless an event routes it', () => {
  const DENIED = [
    { tool_input: { path: '/project/.env' } },
    { tool_input: { command: 'cat .env' } },
    { hook_event_name: 'preToolUse', tool_input: { path: '/project/.env' } },
    { tool_name: null, tool_input: { path: '/project/.env' } },
    { tool_name: 0, tool_input: { path: '/project/.env' } },
    { tool_name: false, tool_input: { path: '/project/.env' } },
  ];
  for (const payload of DENIED) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim(), 'stdout must never be empty under failClosed');
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(payload)}`);
  }
});

test('[a3-h3] array and non-object top levels deny with JSON, never empty stdout', () => {
  for (const payload of ['[]', '["rm -rf /"]', '[{"tool_name":"Write"}]', 'null', '5', 'true', '"str"']) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, `exit 0 expected for ${payload}: ${r.stderr}`);
    assert.ok(r.stdout.trim(), `stdout must not be empty for ${payload}`);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  }
});

test('[a3] every A3 payload shape emits parseable JSON (failClosed invariant)', () => {
  const SHAPES = [
    '[]', 'null', '{}', '',
    JSON.stringify({ hook_event_name: 'BeforeMCPExecution', tool_name: 'Shell', tool_input: { command: 'ls', path: '/project/.env' } }),
    JSON.stringify({ hook_event_name: 'BOGUS', tool_name: 'Shell', tool_input: { command: 'ls' } }),
    JSON.stringify({ hook_event_name: 'BEFORESHELLEXECUTION', tool_name: 'mcp__x__y', tool_input: { command: 'ls' } }),
    JSON.stringify({ tool_input: { path: '/project/.env' } }),
    JSON.stringify({ tool_name: 0, tool_input: {} }),
  ];
  for (const payload of SHAPES) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, `exit 0 expected for ${payload || '(empty)'}`);
    assert.ok(r.stdout.trim(), `empty stdout is dangerous under failClosed: ${payload || '(empty)'}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.permission === 'allow' || out.permission === 'deny',
      `verdict must be allow or deny, got ${JSON.stringify(out)}`);
  }
});

// === A3 repair cycle 4: folded alias / destination / command keys ===
// The earlier round argued this adapter's exact-case key reads were safe
// because an unrecognised spelling goes unread and the branch then fails
// toward DENY. That holds for a payload carrying ONE spelling — and every
// probe run at the time carried one. It breaks on a COLLISION: a safe
// canonical key satisfies the branch while the dangerous folded twin is
// never seen, and the verdict is allow. Testing one variable when the
// defect needed two is what hid it.

test('[a3r4] a safe canonical key cannot shadow a dangerous folded twin', () => {
  const COLLIDING = [
    // destination fields
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', File_Path: '/project/.env' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', FILE_PATH: '/project/.env' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', FilePath: '/project/.env' } },
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/safe.ts', PATH: '/project/.env' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', URI: 'file:///project/.env' } },
    // tool_input container
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts' }, Tool_Input: { path: '/project/.env' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts' }, TOOLINPUT: { path: '/project/.env' } },
    // shell command
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell',
      tool_input: { command: 'ls', Command: 'cat .env' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell',
      tool_input: { command: 'ls' }, COMMAND: 'cat .env' },
    // tool_name and hook_event_name
    { tool_name: 'Read', Tool_Name: 'Write', tool_input: { path: '/project/.env' } },
    { hook_event_name: 'beforeShellExecution', Hook_Event_Name: 'beforeMCPExecution',
      tool_name: 'Shell', tool_input: { command: 'ls', path: '/project/.env' } },
  ];
  for (const payload of COLLIDING) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim(), 'stdout must never be empty under failClosed');
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `shadowed: ${JSON.stringify(payload)}`);
  }
});

test('[a3r4] folded aliases that AGREE are still not treated as a conflict', () => {
  const AGREEING = [
    { tool_name: 'Write', Tool_Name: 'Write',
      tool_input: { path: '/tmp/safe.ts', contents: 'ok' } },
    { tool_name: 'Write',
      tool_input: { path: '/tmp/safe.ts', File_Path: '/tmp/safe.ts', contents: 'ok' } },
    { hook_event_name: 'beforeShellExecution', HOOK_EVENT_NAME: 'beforeShellExecution',
      tool_name: 'Shell', tool_input: { command: 'ls' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell',
      tool_input: { command: 'ls' }, Command: 'ls' },
  ];
  for (const payload of AGREEING) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'allow',
      `false conflict: ${JSON.stringify(payload)}`);
  }
});

test('[a3r4] folded destination keys are validated on their own, not only in collision', () => {
  for (const tool_input of [
    { File_Path: '/project/.env' },
    { FILE_PATH: '/project/.env' },
    { Target_File: '/project/prod.env' },
    { URI: 'file:///project/.env' },
  ]) {
    const r = runHook(ENFORCE, { tool_name: 'Write', tool_input });
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `deny expected for ${JSON.stringify(tool_input)}`);
  }
});

test('[a3r4] folding the aliases did not widen the accepted vocabulary', () => {
  // Same names as before, matched case-insensitively. A key that merely
  // resembles a destination field is still not a destination, so the
  // mutation branch still denies for "no usable path" rather than
  // silently validating something new.
  const r = runHook(ENFORCE, { tool_name: 'Write', tool_input: { destination: '/tmp/safe.ts' } });
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  assert.match(JSON.parse(r.stdout).agent_message || '', /no usable path/i);
});

test('[a3r4] the git tokenizer fix reaches Cursor through enforce.js', () => {
  const DENIED = [
    'Git --git-dir=/r push --force origin main',
    '/usr/bin/GIT --git-dir=/r push --force origin main',
    './git --git-dir=/r push --force origin main',
    '/bin/rm -rf /',
    'RM -rf /',
    'BASH -c "git push --force origin main"',
  ];
  for (const command of DENIED) {
    const r = runHook(ENFORCE, {
      hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command },
    });
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `must deny: ${command}`);
  }
});

test('[a3r4] ordinary Cursor traffic is unaffected by the folding', () => {
  const ALLOWED = [
    [{ hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'ls' } }],
    [{ hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'git push origin main' } }],
    [{ tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', contents: 'ok' } }],
    [{ hook_event_name: 'preToolUse', tool_name: 'Read', tool_input: { path: '/etc/hosts' } }],
    [{ hook_event_name: 'beforeMCPExecution', tool_name: 'mcp__g__query', tool_input: {} }],
  ];
  for (const [payload] of ALLOWED) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'allow',
      `false deny: ${JSON.stringify(payload)}`);
  }
});

// === A3 repair cycle 5 — the reflected-secret leak ===

test('[a3r5] a malformed MCP tool_input never echoes its bytes back', () => {
  // `return { ok: false, reason: err.message }` put the JSON parse error —
  // which embeds the offending input — straight into agent_message on
  // stdout. A short secret came back verbatim. Every other diagnostic in
  // these hooks is a constant plus a hash; this was the one site that
  // still reflected raw caller bytes.
  // The previous version of this test was VACUOUS. It used
  // `{bad ${secret}` — a shape for which V8 reports only "Expected
  // property name or '}' in JSON at position 1", with the input nowhere in
  // the message. So reverting the source to `err.message` would not have
  // reflected the secret either; the test went red only because the hash
  // assertion vanished. It never controlled for the leak it names.
  //
  // That is the same V8 property I had correctly identified in the SOURCE
  // one cycle earlier and then failed to apply to the TEST.
  //
  // Measured, so the control is real: for a BARE token V8 says
  // `Unexpected token 'S', "SK_7f4c" is not valid JSON` — the input IS in
  // the message. Those shapes are used below.
  const SECRETS = [
    'SK_7f4c',
    'ghp_' + 'LIVETOKEN123',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'xoxb-' + '9999-secret',
    'password=hunter2',
  ];
  for (const secret of SECRETS) {
    // Sanity: assert this shape really would leak under the old code.
    let parseMessage = '';
    try { JSON.parse(secret); } catch (err) { parseMessage = err.message; }
    assert.ok(parseMessage.includes(secret),
      `control is vacuous — V8 does not put ${secret} in its message`);
    const r = runHook(ENFORCE, {
      hook_event_name: 'beforeMCPExecution',
      tool_name: 'MCP: x/y',
      tool_input: secret,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.permission, 'deny');
    assert.ok(!r.stdout.includes(secret),
      `secret reflected to stdout: ${r.stdout}`);
    assert.ok(!(r.stderr || '').includes(secret),
      `secret reflected to stderr: ${r.stderr}`);
    assert.match(out.agent_message || '', /detail_sha256_12=[0-9a-f]{12}/,
      'the diagnostic must carry a hash instead of the value');
  }
});

test('[a3r5] the hashed diagnostic still distinguishes different failures', () => {
  // A constant with no hash would make every parse failure look alike.
  const a = JSON.parse(runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution', tool_name: 'MCP: x/y', tool_input: '{bad AAAA',
  }).stdout).agent_message;
  const b = JSON.parse(runHook(ENFORCE, {
    hook_event_name: 'beforeMCPExecution', tool_name: 'MCP: x/y', tool_input: '{{{{ BBBB',
  }).stdout).agent_message;
  assert.match(a, /detail_sha256_12=/);
  assert.match(b, /detail_sha256_12=/);
  assert.notStrictEqual(a, b, 'distinct failures must hash differently');
});

test('[a3r5] cursor still denies everything it denied before', () => {
  const DENY = [
    { tool_name: 'Write', tool_input: { path: '/tmp/.env', contents: 'x' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'cat .env' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'Git --git-dir=/r push --force origin main' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: '/bin/rm -rf /' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', File_Path: '/project/.env' } },
    { hook_event_name: 'BeforeMCPExecution', tool_name: 'Shell', tool_input: { command: 'ls', path: '/project/.env' } },
  ];
  for (const payload of DENY) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny',
      `weakened: ${JSON.stringify(payload)}`);
  }
  const ALLOW = [
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'ls' } },
    { hook_event_name: 'beforeShellExecution', tool_name: 'Shell', tool_input: { command: 'env=development node app.js' } },
    { tool_name: 'Write', tool_input: { path: '/tmp/safe.ts', contents: 'ok' } },
  ];
  for (const payload of ALLOW) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'allow',
      `false deny: ${JSON.stringify(payload)}`);
  }
});

test('[a3r6] no caller-supplied bytes reach the output on ANY deny path', () => {
  // clip() bounded but did not redact, and it was used at five sites.
  // This sweeps every path that used to reflect: unknown tool, both
  // event/name mismatches, mutation-without-path (name AND the offending
  // field name), and the alias-conflict reason (caller key names).
  const M = 'ZZmarkerZZ';
  const PATHS = [
    ['unknown tool', { hook_event_name: 'preToolUse', tool_name: M, tool_input: { path: '/x' } }],
    ['shell event, non-shell name', { hook_event_name: 'beforeShellExecution', tool_name: `Write${M}`, tool_input: { command: 'ls' } }],
    ['mcp event, non-mcp name', { hook_event_name: 'beforeMCPExecution', tool_name: `Shell${M}`, tool_input: { command: 'ls' } }],
    ['mutation without path', { tool_name: 'Write', tool_input: { [`path${M}`]: '/x' } }],
    ['mutation, unreadable dest field', { tool_name: 'Write', tool_input: { path: '', contents: M } }],
    ['unrecognised event spelling', { hook_event_name: M, tool_name: 'Nope', tool_input: {} }],
  ];
  for (const [label, payload] of PATHS) {
    const r = runHook(ENFORCE, payload);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim(), `stdout must not be empty (${label})`);
    assert.strictEqual(JSON.parse(r.stdout).permission, 'deny', `deny expected (${label})`);
    assert.ok(!r.stdout.includes(M), `caller bytes reflected on the ${label} path: ${r.stdout}`);
    assert.ok(!(r.stderr || '').includes(M), `caller bytes on stderr (${label})`);
  }
});

test('[a3r6] conflicting alias key NAMES are hashed, not listed', () => {
  const r = runHook(ENFORCE, {
    tool_name: 'Read', ToolNameZZ: 'Write', Tool_Name: 'Write', tool_input: { path: '/x' },
  });
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny');
  assert.ok(!r.stdout.includes('Tool_Name'), `alias key name reflected: ${r.stdout}`);
  assert.match(JSON.parse(r.stdout).agent_message || '', /names_sha256_12=[0-9a-f]{12}/);
});

test('[a3r6] a huge tool_name still produces a small, complete verdict', () => {
  // Truncation used to be what kept the reply inside the pipe buffer.
  // Hashing subsumes that: the diagnostic is fixed width whatever arrives.
  const r = runHook(ENFORCE, {
    hook_event_name: 'preToolUse', tool_name: 'X'.repeat(400000), tool_input: {},
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.permission, 'deny');
  assert.ok(r.stdout.length < 1024, `diagnostic must be fixed width, got ${r.stdout.length}`);
});
