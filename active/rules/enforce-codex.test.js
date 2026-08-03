#!/usr/bin/env node
/**
 * Smoke + correctness tests for enforce-codex.js.
 * Run: node --test active/rules/enforce-codex.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.join(__dirname, 'enforce-codex.js');

// Every spawn defaults to a throwaway JARVIS_CORTEX_ROOT. getCodexDir()
// honours it, so blocking tests append their synthetic BLOCKED records
// there instead of to the owner's real ~/.codex/debug/jarvis-enforce.log.
// Running the suite must not write to the audit trail this hook exists to
// produce — runRaw had no env override at all.
const SUITE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-suite-'));
process.on('exit', () => {
  try { fs.rmSync(SUITE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});
const SUITE_ENV = { ...process.env, JARVIS_CORTEX_ROOT: SUITE_ROOT };
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


function runHook(payload = {}, options = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: childEnv(options)
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runRaw(stdin = '') {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    env: SUITE_ENV
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('[smoke] empty stdin does not crash', () => {
  const result = runRaw('');
  assert.strictEqual(result.code, 0);
});

test('[smoke] malformed JSON exits 2 (fail-closed, H1 audit)', () => {
  // Round 5 (hm-security) audit H1: Codex hook previously returned
  // 0 on parse error (fail-OPEN). Round 5 made the read-and-parse
  // path fail-closed at the top of main().
  const result = runRaw('not json {{{');
  assert.strictEqual(result.code, 2);
});

test('[correctness] safe command passes through', () => {
  const result = runHook({ tool_input: { command: 'echo safe' } });
  assert.strictEqual(result.code, 0);
});

test('[correctness] force push blocks', () => {
  const command = ['git', 'push', '--' + 'force', 'origin', 'main'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Force push/);
});

test('[correctness] force push with short flag before remote blocks', () => {
  const command = ['git', 'push', '-' + 'f', 'origin', 'main'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Force push/);
});

test('[correctness] force push with plus refspec blocks', () => {
  const command = ['git', 'push', 'origin', '+main'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Force push/);
});

test('[correctness] force-with-lease push passes', () => {
  const command = ['git', 'push', '--force-with-lease', 'origin', 'main'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr.trim(), '');
});

test('[correctness] pm2 lifecycle command blocks', () => {
  const command = ['pm2', 're' + 'start', 'api'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /PM2/);
});

test('[correctness] recursive force delete on absolute path blocks', () => {
  const command = ['rm', '-r' + 'f', '/tmp/jarvis-danger-test'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Recursive force delete/);
});

test('[correctness] recursive force delete on dot blocks', () => {
  const command = ['rm', '-r' + 'f', '.'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Recursive force delete/);
});

test('[correctness] recursive force delete on quoted home blocks', () => {
  const command = ['rm', '-r' + 'f', '"~"'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Recursive force delete/);
});

test('[correctness] recursive force delete on HOME variable blocks', () => {
  const command = ['rm', '-r' + 'f', '$HOME'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Recursive force delete/);
});

test('[correctness] recursive force delete on ordinary relative directory passes', () => {
  const command = ['rm', '-r' + 'f', 'node_modules'].join(' ');
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 0);
});

test('[correctness] SQL destructive statement blocks', () => {
  const command = 'psql -c "' + 'DR' + 'OP TABLE users"';
  const result = runHook({ tool_input: { command } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /SQL DROP/);
});

test('[correctness] top-level command payload is supported', () => {
  const command = ['git', 'push', 'origin', 'main', '-' + 'f'].join(' ');
  const result = runHook({ command });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /Force push/);
});

test('[correctness] argv payload is supported', () => {
  const result = runHook({ tool_input: { argv: ['pm2', 'st' + 'op', 'api'] } });
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /PM2/);
});

test('[correctness] harmless command passes', () => {
  const result = runHook({ tool_input: { command: 'git status --short' } });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stderr.trim(), '');
});

test('[privacy] blocked command log stores hash instead of raw command', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-enforce-home-'));
  const secret = 'super-secret-token-123';
  const command = ['git', 'push', '--' + 'force', 'origin', secret].join(' ');

  try {
    const result = runHook(
      { tool_input: { command } },
      { env: { ...process.env, HOME: tmpHome } }
    );
    assert.strictEqual(result.code, 2);

    const logPath = path.join(tmpHome, '.codex', 'debug', 'jarvis-enforce.log');
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /command_sha256_12=[a-f0-9]{12}/);
    assert.doesNotMatch(log, /git push/);
    assert.doesNotMatch(log, new RegExp(secret));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// === Round 7 (loop-hermes) regression tests for codex side ===
// Mirror of the Claude enforce.test.js round 7 cases. Without
// these, the codex hook can silently regress (LOW-5 reviewer).

test('[round7] bash writes to protected file (audit C9) — codex', () => {
  const WRITE_CASES = [
    'tee /project/.env < /etc/passwd',
    'tee /project/.envrc < /etc/shadow',
    'cp /etc/passwd /project/.env',
    'mv /etc/passwd /project/.env',
    'sed -i s/x/y/ /project/.env',
    'perl -pi -e s/x/y/ /project/.env',
    'perl -i.bak -pe s/x/y/ /project/.env',
    'dd if=/etc/passwd of=/project/.env',
    'ln -s /etc/passwd /project/.env',
    'install /etc/passwd /project/.env',
    'touch /project/.env',
    'echo evil > /project/.env',
    'cat /etc/passwd > /project/.env',
    'cat /etc/passwd >> /project/.env',
    'xargs -I {} cp {} /project/.env < filelist',
    // Round 7 reviewer MEDIUM-2: quoted redirect target
    'bash -c "echo evil > /project/.env"',
    'eval \'echo evil > /project/.env\'',
    // Round 7 reviewer MEDIUM-3: buried path in non-introducer command
    'python3 -c "open(\'/project/.env\',\'w\').write(\'evil\')"',
    'awk \'BEGIN{print > "/project/.env"}\' </dev/null',
    // Backup-file Write (audit M3) via Bash with redirect
    'echo "DANGEROUS_COMMANDS = []" > /x/active/rules/enforce.js.bak',
    'cp /tmp/x /x/active/rules/enforce.js.backup',
    'mv evil.js /x/active/skills/strategic-compact/session-start.js~'
  ];
  for (const cmd of WRITE_CASES) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_input: { command: cmd } }),
      encoding: 'utf8',
      timeout: 10000,
      env: SUITE_ENV
    });
    assert.strictEqual(r.status, 2,
      `Bash write to protected file must exit 2 (block), got ${r.status}: ${cmd}`);
  }
});

test('[round7] safe Bash commands do not block on codex side', () => {
  const SAFE_COMMANDS = [
    'echo hi > /tmp/log',
    'cp foo /tmp/bar',
    'mv oldname.txt newname.txt',
    'tee /tmp/notes.txt <<< hello',
    'sed -i s/x/y/ /tmp/config',
    'ls -la',
    'git status',
    'npm test',
    'cat README.md | head -20'
  ];
  for (const cmd of SAFE_COMMANDS) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_input: { command: cmd } }),
      encoding: 'utf8',
      timeout: 10000,
      env: SUITE_ENV
    });
    assert.strictEqual(r.status, 0,
      `Safe command must exit 0, got ${r.status}: ${cmd}`);
  }
});

// === .env permissive-substring policy (A3) ===
// Mirror of the Claude-side [a3] cases. The codex hook hard-blocks
// (exit 2) instead of returning an "ask" decision.


test('[a3] real .env paths hard-block under the permissive rule', () => {
  const GATED = [
    'cat .env',
    'cat /path/to/.env.local',
    'cat .env.production',
    'echo x > ".env"',
    'cat /project/.envrc',
    'python3 -c "open(\'/project/.env\',\'w\')"'
  ];
  for (const cmd of GATED) {
    const r = runHook({ tool_input: { command: cmd } });
    assert.strictEqual(r.code, 2,
      `real .env access must still block (exit 2): ${cmd} — got ${r.code}`);
  }
});

// === A3 repair cycle 1 (codex twin) ===

test('[a3r1] shell-variable path prefix is not a bypass — codex', () => {
  const CASES = [
    'D=/project/; echo x > $D.env',
    'D=/project/; echo x > "$D.env"',
    'D=/project/; tee $D.env < /etc/passwd',
    'echo x > ${D}.env',
    'echo x > "$D".env',
    'echo x > $D/.env',
    'echo x > $1.env',
    'cp /etc/passwd $DIR.env'
  ];
  for (const cmd of CASES) {
    const r = runHook({ tool_input: { command: cmd } });
    assert.strictEqual(r.code, 2,
      `shell-variable .env path must block (exit 2): ${cmd} — got ${r.code}`);
  }
});

test('[a3r1] recognized shell path positions keep permissive coverage — codex', () => {
  const CASES = [
    'echo x > prod.env',
    'cat prod.env',
    'rm prod.env',
    'cp /etc/passwd prod.env',
    'tee prod.env < /etc/passwd'
  ];
  for (const cmd of CASES) {
    const r = runHook({ tool_input: { command: cmd } });
    assert.strictEqual(r.code, 2,
      `path-position .env must block (exit 2): ${cmd} — got ${r.code}`);
  }
});


test('[a3r1] structured file_path keeps permissive .env coverage — codex', () => {
  // filePathsFromPayload() -> isProtectedFile() is a structured
  // position: unambiguous, so it uses the permissive pattern.
  for (const filePath of ['/project/prod.env', '/project/a.b.env', '/project/local.env']) {
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: filePath } });
    assert.strictEqual(r.code, 2, `Write ${filePath} must block (exit 2) — got ${r.code}`);
  }
  // Template exemption survives.
  const t = runHook({ tool_name: 'Write', tool_input: { file_path: '/project/.env.example' } });
  assert.strictEqual(t.code, 0, `template must pass — got ${t.code}`);
});



test('[a3r3] reason carries no input — sentinel absent from output and log — codex', () => {
  const SENTINEL = 'TOKEN_SENSITIVE_SENTINEL_9d2f';
  for (const payload of [
    { tool_input: { command: `cat /secret/${SENTINEL}.env` } },
    { tool_input: { command: `cp x /secret/${SENTINEL}.env` } },
    { tool_name: 'Write', tool_input: { file_path: `/secret/${SENTINEL}.env` } },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-sent-'));
    try {
      const r = runHook(payload, { env: { ...process.env, JARVIS_CORTEX_ROOT: root } });
      assert.strictEqual(r.code, 2, 'must block');
      const all = (r.stdout || '') + (r.stderr || '');
      assert.ok(!all.includes(SENTINEL), `sentinel leaked into output: ${all}`);
      // The old version asserted on output only and never opened the log.
      const logPath = path.join(root, 'codex', 'debug', 'jarvis-enforce.log');
      assert.ok(fs.existsSync(logPath), `a blocked action must be logged: ${logPath}`);
      const log = fs.readFileSync(logPath, 'utf8');
      assert.ok(!log.includes(SENTINEL), `sentinel leaked into log: ${log}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('[a3r3] permissive pattern restored — codex', () => {
  for (const cmd of ['cat prod.env', 'cat .env', 'echo x > $D.env', 'rm -f prod.env']) {
    const r = runHook({ tool_input: { command: cmd } });
    assert.strictEqual(r.code, 2, `must block: ${cmd}`);
  }
  // Accepted noise.
  const n = runHook({ tool_input: { command: 'grep -rn process.env tests/' } });
  assert.strictEqual(n.code, 2, 'process.env noise is the accepted cost');
});

test('[a3r4] codex log record is one line with no caller-controlled field', () => {
  const SENTINEL = 'SENTINEL_CMD_7b1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-log-'));
  try {
    const r = runHook(
      { tool_input: { command: `cat /secret/${SENTINEL}.env\n[2026-01-01] BLOCKED: FORGED_ENTRY` } },
      { env: { ...process.env, JARVIS_CORTEX_ROOT: root } },
    );
    assert.strictEqual(r.code, 2, 'must block');
    const logPath = path.join(root, 'codex', 'debug', 'jarvis-enforce.log');
    assert.ok(fs.existsSync(logPath), 'a block must be logged');
    const log = fs.readFileSync(logPath, 'utf8');
    assert.ok(!log.includes(SENTINEL), `command leaked into log: ${log}`);
    assert.ok(!log.includes('FORGED_ENTRY'), `log record forgery: ${log}`);
    assert.strictEqual(log.trim().split('\n').length, 1, `expected one line, got: ${log}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[a3r5] alias shadowing: every supplied command and path is validated — codex', () => {
  // First-usable-alias let a safe value shadow a dangerous one.
  const SHADOWED = [
    { tool_name: 'Bash', command: 'ls', tool_input: { command: 'rm -rf /' } },
    { tool_name: 'Bash', tool_input: { command: 'ls' }, input: { command: 'rm -rf /' } },
    { tool_name: 'Bash', cmd: 'ls', tool_input: { command: 'cat .env' } },
    { tool_name: 'Write', tool_input: { file_path: '/tmp/safe.txt' }, input: { file_path: '/project/.env' } },
    { tool_name: 'Write', tool_input: { file_path: '/tmp/safe.txt' }, arguments: { file_path: '/project/.env' } },
  ];
  for (const payload of SHADOWED) {
    const r = runHook(payload);
    assert.strictEqual(r.code, 2,
      `shadowed dangerous alias must block: ${JSON.stringify(payload)} — got ${r.code}`);
  }
});

test('[a3r5] all-safe aliases still pass — codex', () => {
  const r = runHook({ tool_name: 'Bash', command: 'ls', tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.code, 0, 'safe aliases must not be blocked');
});

test('[a3r5] parse failure emits a constant message, no caller text, one line — codex', () => {
  const r = runRaw('not json\n[2026-01-01] BLOCKED: FORGED_STDERR_ENTRY');
  assert.strictEqual(r.code, 2, 'malformed payload must fail closed');
  const err = (r.stderr || '').trim();
  assert.ok(!err.includes('FORGED_STDERR_ENTRY'), `caller text echoed to stderr: ${err}`);
  assert.strictEqual(err.split('\n').length, 1, `expected one stderr line, got: ${err}`);
  assert.match(err, /detail_sha256_12=[0-9a-f]{12}/, 'detail must be hashed');
});

test('[a3r5] codex log strips C1 and format controls — codex', () => {
  const NEL = String.fromCharCode(0x85);
  const CSI = String.fromCharCode(0x9b);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-c1-'));
  try {
    runHook({ tool_input: { command: `cat /secret/a.env${NEL}FORGED_A${CSI}FORGED_B` } },
      { env: { ...process.env, JARVIS_CORTEX_ROOT: root } });
    const log = fs.readFileSync(path.join(root, 'codex', 'debug', 'jarvis-enforce.log'), 'utf8');
    for (const ch of [NEL, CSI]) {
      assert.ok(!log.includes(ch), `control U+${ch.codePointAt(0).toString(16)} survived`);
    }
    assert.strictEqual(log.trim().split('\n').length, 1, `expected one line, got: ${log}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === A3 (H3): non-plain-object top levels ===
// `!data || typeof data !== 'object'` is FALSE for `[]`: arrays are
// truthy and typeof 'object'. An array payload therefore passed the
// shape check and flowed into filePathsFromPayload / commandsFromPayload,
// where `data.command` and `data.tool_input` are undefined — the guard
// exited 0 having validated nothing.
//
// Honest scope: no JSON array can carry those fields, so this is a shape
// defect rather than a demonstrated command bypass. It is closed because
// the top level of a tool payload is a plain object or it is not a
// payload this guard can evaluate — and because active/rules/enforce.js
// already rejected arrays, so leaving it open was a parity gap between
// two guards that are meant to stay in sync.

test('[a3-h3] array top-level payload exits 2, not 0 — codex', () => {
  for (const raw of ['[]', '["rm -rf /"]', '[{"tool_input":{"command":"cat .env"}}]']) {
    const r = runRaw(raw);
    assert.strictEqual(r.code, 2, `array top-level ${raw} must fail closed`);
  }
});

test('[a3-h3] other non-object top levels still exit 2 — codex', () => {
  for (const raw of ['null', '5', '"str"', 'true']) {
    const r = runRaw(raw);
    assert.strictEqual(r.code, 2, `top-level ${raw} must fail closed`);
  }
});

test('[a3-h3] object payloads are unaffected by the array rejection — codex', () => {
  // Empty stdin still allows, `{}` still allows (no command, no path),
  // and a real object payload still reaches the gates.
  assert.strictEqual(runRaw('').code, 0, 'empty stdin must stay exit 0');
  assert.strictEqual(runRaw('{}').code, 0, 'bare {} must stay exit 0');
  assert.strictEqual(runHook({ tool_input: { command: 'echo safe' } }).code, 0);
  assert.strictEqual(runHook({ tool_input: { command: 'rm -rf /' } }).code, 2);
  assert.strictEqual(runHook({ tool_input: { file_path: '/project/.env' } }).code, 2);
});

test('[a3] permissive .env gate unchanged from HEAD — codex', () => {
  // `grep -rn process.env tests/` hard-blocks on the Codex side. That is
  // the documented cost of the permissive pattern, not a regression.
  assert.strictEqual(
    runHook({ tool_input: { command: 'grep -rn process.env tests/' } }).code, 2);
  assert.strictEqual(
    runHook({ tool_input: { file_path: '/project/.env.example' } }).code, 0);
});

// === A3 repair cycle 2: payload key lookup must be case-folded ===
// The extraction helpers read literal property paths, and a property name
// is part of the payload — so the caller controlled its spelling and the
// exact-case read failed OPEN. `{"tool_input":{"Command":"rm -rf /"}}`
// was invisible to the guard and exited 0 while the lowercase spelling
// exited 2. Same defect class as the tool-name gate in enforce.js, but
// failing open instead of closed.
//
// Exit code is a sufficient discriminator in this file, unlike enforce.js:
// this guard has no stdout writer at all. That is asserted below rather
// than assumed.

test('[a3r2] a dangerous command cannot hide behind a key capitalisation', () => {
  const RM = 'rm -rf /';
  const SPELLINGS = [
    { tool_input: { command: RM } },
    { tool_input: { Command: RM } },
    { tool_input: { COMMAND: RM } },
    { tool_input: { CoMmAnD: RM } },
    { Command: RM },
    { CMD: RM },
    { input: { Cmd: RM } },
    { arguments: { COMMAND: RM } },
    { tool_input: { CoMmAnD: ['rm', '-rf', '/'] } },
    { tool_input: { ARGV: ['rm', '-rf', '/'] } },
    { Argv: ['git', 'push', '--force', 'origin', 'main'] },
    { input: { ARGV: ['cat', '/project/.env'] } },
  ];
  for (const payload of SPELLINGS) {
    assert.strictEqual(runHook(payload).code, 2,
      `must block: ${JSON.stringify(payload)}`);
  }
});

test('[a3r2] a protected path cannot hide behind a key capitalisation', () => {
  const ENV = '/project/.env';
  const SPELLINGS = [
    { tool_input: { file_path: ENV } },
    { tool_input: { File_Path: ENV } },
    { tool_input: { FILE_PATH: ENV } },
    { tool_input: { FILEPATH: ENV } },
    { tool_input: { FilePath: ENV } },
    { input: { File_Path: ENV } },
    { arguments: { FilePath: ENV } },
  ];
  for (const payload of SPELLINGS) {
    assert.strictEqual(runHook(payload).code, 2,
      `must block: ${JSON.stringify(payload)}`);
  }
});

test('[a3r2] folded-key collisions yield every value, none silently wins', () => {
  // The validate-all property won in the alias round now has to hold
  // across CASE too: `command` and `Command` in the same object are two
  // candidates, not one. If either is dangerous, the payload blocks
  // regardless of declaration order.
  const RM = 'rm -rf /';
  const ENV = '/project/.env';
  const COLLIDING = [
    { tool_input: { command: 'echo safe', Command: RM } },
    { tool_input: { command: RM, Command: 'echo safe' } },
    { tool_input: { cmd: 'echo safe', CMD: RM } },
    { tool_input: { file_path: '/tmp/ok.ts', File_Path: ENV } },
    { tool_input: { File_Path: ENV, file_path: '/tmp/ok.ts' } },
    { tool_input: { file_path: '/tmp/ok.ts' }, input: { File_Path: ENV } },
  ];
  for (const payload of COLLIDING) {
    assert.strictEqual(runHook(payload).code, 2,
      `no candidate may be shadowed: ${JSON.stringify(payload)}`);
  }
});

test('[a3r2] folding is exact-after-folding, not a prefix or substring match', () => {
  // The vocabulary is unchanged: command/cmd, argv, file_path/filepath.
  // A key that merely resembles one of them is still not read. This pins
  // the change as a FOLDING change and would go red if someone later
  // relaxed the match into startsWith/includes.
  const NEAR_MISSES = [
    { tool_input: { PATH: '/project/.env' } },
    { tool_input: { path: '/project/.env' } },
    { tool_input: { command_prefix: 'rm -rf /' } },
    { tool_input: { cmdline: 'rm -rf /' } },
    { tool_input: { subcommand: 'rm -rf /' } },
    { tool_input: { argv_hint: ['rm', '-rf', '/'] } },
  ];
  for (const payload of NEAR_MISSES) {
    assert.strictEqual(runHook(payload).code, 0,
      `must NOT be pulled into scope: ${JSON.stringify(payload)}`);
  }
});

test('[a3r2] non-object containers yield nothing instead of throwing', () => {
  const SHAPES = [
    {}, { tool_input: null }, { tool_input: [] }, { tool_input: 'str' },
    { tool_input: 5 }, { tool_input: true }, { input: [], arguments: null },
    { arguments: 'x', input: 7 },
  ];
  for (const payload of SHAPES) {
    const r = runHook(payload);
    assert.strictEqual(r.code, 0, `must not block: ${JSON.stringify(payload)}`);
    assert.ok(!/TypeError|ReferenceError|at Object\./.test(r.stderr || ''),
      `container walk threw on ${JSON.stringify(payload)}: ${r.stderr}`);
  }
});

test('[a3r2] the guard has no stdout path, so exit code is a sufficient signal', () => {
  // In enforce.js exit 0 means both "asked" and "passed free", which is
  // what made an exit-code-only reading misleading. Here there is no ask
  // path and no stdout writer, so the two cannot be confused — asserted,
  // not assumed.
  const SHAPES = [
    {}, { tool_input: { command: 'echo safe' } },
    { tool_input: { Command: 'rm -rf /' } },
    { tool_input: { File_Path: '/project/.env' } },
    { tool_input: null },
  ];
  for (const payload of SHAPES) {
    assert.strictEqual((runHook(payload).stdout || '').trim(), '',
      `unexpected stdout for ${JSON.stringify(payload)}`);
  }
  assert.strictEqual((runRaw('[]').stdout || '').trim(), '');
  assert.strictEqual((runRaw('').stdout || '').trim(), '');
});

test('[a3r2] safe traffic and the template exemption still pass free', () => {
  assert.strictEqual(runHook({ tool_input: { command: 'echo safe' } }).code, 0);
  assert.strictEqual(runHook({ tool_input: { CoMMand: 'echo safe' } }).code, 0);
  assert.strictEqual(runHook({ tool_input: { File_Path: '/project/.env.example' } }).code, 0);
  // argv keeps its stricter contract: a non-string element means the join
  // is not trusted, under any capitalisation of the key.
  assert.strictEqual(runHook({ tool_input: { ARGV: ['rm', 5, '/'] } }).code, 0);
});

// === A3 repair cycle 3: container coverage is symmetric on purpose ===
// The three extractors disagreed about WHERE to look, and the
// disagreement was drift, not design: commands were read from the
// top-level payload, paths were not; `argv` was read from `tool_input`
// and `input`, but not from `arguments`. The gap failed OPEN. The
// container list is now declared once and consumed by all three, so
// coverage cannot diverge again without deleting a shared call site.

test('[a3r3] a path at the top level is read, exactly as a command is', () => {
  // The asymmetry in one pair: same nesting level, same payload, one
  // blocked and one invisible.
  assert.strictEqual(runHook({ command: 'rm -rf /' }).code, 2,
    'top-level command was always read');
  assert.strictEqual(runHook({ file_path: '/project/.env' }).code, 2,
    'top-level path must be read too');
});

test('[a3r3] argv is read from every container, including arguments', () => {
  assert.strictEqual(runHook({ tool_input: { argv: ['rm', '-rf', '/'] } }).code, 2);
  assert.strictEqual(runHook({ arguments: { argv: ['rm', '-rf', '/'] } }).code, 2,
    'arguments.argv was the unread container');
});

test('[a3r3] all three extractors cover all four containers', () => {
  // One row per (extractor, container) pair. Any future edit that drops a
  // container from one extractor and not the others fails here with the
  // pair named.
  const RM = 'rm -rf /';
  const ENV = '/project/.env';
  const ARGV = ['cat', '/project/.env'];
  const MATRIX = [
    ['command @ top-level', { command: RM }],
    ['command @ tool_input', { tool_input: { command: RM } }],
    ['command @ input', { input: { command: RM } }],
    ['command @ arguments', { arguments: { command: RM } }],
    ['cmd @ top-level', { cmd: RM }],
    ['cmd @ arguments', { arguments: { cmd: RM } }],
    ['file_path @ top-level', { file_path: ENV }],
    ['file_path @ tool_input', { tool_input: { file_path: ENV } }],
    ['file_path @ input', { input: { file_path: ENV } }],
    ['file_path @ arguments', { arguments: { file_path: ENV } }],
    ['filepath @ top-level', { filepath: ENV }],
    ['argv @ top-level', { argv: ARGV }],
    ['argv @ tool_input', { tool_input: { argv: ARGV } }],
    ['argv @ input', { input: { argv: ARGV } }],
    ['argv @ arguments', { arguments: { argv: ARGV } }],
  ];
  for (const [label, payload] of MATRIX) {
    assert.strictEqual(runHook(payload).code, 2, `unread pair: ${label}`);
  }
});

// NOTE: this test is a control for BOTH repair cycles — the newly covered
// containers are reached by cycle 3, and the folded key names by cycle 2 —
// so it goes red under either revert. Cycle-2 controls are the [a3r2]
// tests; cycle-3 controls are the three [a3r3] tests above plus this one.
test('[a3r3] the new coverage is case-folded too, not just the old containers', () => {
  const FOLDED = [
    { File_Path: '/project/.env' },
    { FILEPATH: '/project/.env' },
    { FilePath: '/project/.env' },
    { arguments: { ARGV: ['cat', '/project/.env'] } },
    { Argv: ['rm', '-rf', '/'] },
  ];
  for (const payload of FOLDED) {
    assert.strictEqual(runHook(payload).code, 2,
      `must block: ${JSON.stringify(payload)}`);
  }
});

test('[a3r3] widening the containers did not widen the key vocabulary', () => {
  // Still command/cmd, argv, file_path/filepath — at every level. A key
  // that merely resembles one is not read from the newly covered
  // containers either.
  const NEAR_MISSES = [
    { path: '/project/.env' },
    { PATH: '/project/.env' },
    { target: '/project/.env' },
    { dest: '/project/.env' },
    { script: 'rm -rf /' },
    { arguments: { path: '/project/.env' } },
    { arguments: { cmdline: 'rm -rf /' } },
  ];
  for (const payload of NEAR_MISSES) {
    assert.strictEqual(runHook(payload).code, 0,
      `must NOT be pulled into scope: ${JSON.stringify(payload)}`);
  }
});

test('[a3r3] symmetric coverage does not over-block safe traffic', () => {
  assert.strictEqual(runHook({ file_path: '/tmp/ok.ts' }).code, 0);
  assert.strictEqual(runHook({ file_path: '/project/.env.example' }).code, 0);
  assert.strictEqual(runHook({ arguments: { file_path: '/project/.env.sample' } }).code, 0);
  assert.strictEqual(runHook({ argv: ['echo', 'safe'] }).code, 0);
  assert.strictEqual(runHook({ arguments: { argv: ['echo', 'safe'] } }).code, 0);
  assert.strictEqual(runHook({ arguments: { argv: ['rm', 5, '/'] } }).code, 0,
    'the strict argv contract holds in the newly covered container too');
  assert.strictEqual(runRaw('{}').code, 0);
  assert.strictEqual(runRaw('').code, 0);
});

// === A3 repair cycle 4: executable identity ===
// `tokens[i] !== 'git'` and `token === 'rm'` compared an
// attacker-controlled executable name by exact spelling. The platform
// argument for that ("the shell is case-sensitive") is POSIX, not macOS:
// `command -v RM` -> /bin/RM, `Git --version` -> git version 2.54.0. Path
// invocations never matched either. This guard was hit hardest because it
// has NO regex backstop for git push or rm — the tokenizer is its only
// detector, so every form below passed free here while enforce.js still
// caught them via its /i regexes.

test('[a3r4] git is identified by folded basename, not exact token — codex', () => {
  for (const command of [
    'Git push --force origin main',
    'GIT push --force origin main',
    '/usr/bin/git push --force origin main',
    '/usr/bin/GIT --git-dir=/r push --force origin main',
    './git --git-dir=/r push --force origin main',
    'sudo /usr/bin/git push --force origin main',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `escaped the tokenizer: ${command}`);
  }
});

test('[a3r4] rm is identified by folded basename, not exact token — codex', () => {
  for (const command of [
    'RM -rf /',
    'Rm -rf /',
    '/bin/rm -rf /',
    '/bin/RM -rf /',
    './rm -rf /',
    'sudo /bin/rm -rf /',
    'env /bin/rm -rf ~',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `escaped the tokenizer: ${command}`);
  }
});

test('[a3r4] BASH -c is flattened under any capitalisation — codex', () => {
  for (const command of [
    'bash -c "git push --force origin main"',
    'BASH -c "git push --force origin main"',
    'Bash -c "rm -rf /"',
    'ZSH -c "rm -rf /"',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `not flattened: ${command}`);
  }
});

test('[a3r4] write-introducer executables match by folded basename — codex', () => {
  for (const command of [
    '/bin/tee /project/.env',
    'TEE /project/.env',
    '/bin/CP /tmp/x /project/.env',
    '/usr/bin/sed -i s/a/b/ /project/.env',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `not blocked: ${command}`);
  }
});

test('[a3r4] flags and git subcommands stay case-sensitive — codex', () => {
  // Verified on this machine: `git PUSH` -> "git: 'PUSH' is not a git
  // command". Folding the subcommand or the flags adds false positives
  // and closes nothing, so these must NOT block.
  assert.strictEqual(runHook({ tool_input: { command: 'git --git-dir=/r PUSH --MIRROR origin' } }).code, 0);
  assert.strictEqual(runHook({ tool_input: { command: 'git push --FORCE origin main' } }).code, 0);
  assert.strictEqual(runHook({ tool_input: { command: 'git_exec_path=/tmp git status' } }).code, 0);
});

test('[a3r4] basename folding does not over-block ordinary commands — codex', () => {
  for (const command of [
    'echo safe',
    'cp /repo/git /tmp/backup',
    'ls -la /usr/bin/git',
    'cat notes-about-rm.txt',
    'echo "rm is a command"',
    'git push origin main',
    'git push --force-with-lease origin main',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `false positive: ${command}`);
  }
});

// === A3 repair cycle 5 (FIX bucket) — codex ===

test('[a3r5] container NAMES are folded, and every match is validated', () => {
  const RM = 'rm -rf /';
  const ENV = '/project/.env';
  const FOLDED = [
    { Tool_Input: { command: RM } },
    { TOOL_INPUT: { command: RM } },
    { INPUT: { command: RM } },
    { Input: { cmd: RM } },
    { ARGUMENTS: { file_path: ENV } },
    { Arguments: { FilePath: ENV } },
    { Tool_Input: { ARGV: ['rm', '-rf', '/'] } },
  ];
  for (const payload of FOLDED) {
    assert.strictEqual(runHook(payload).code, 2, `invisible container: ${JSON.stringify(payload)}`);
  }
});

test('[a3r5] a safe canonical container cannot shadow a dangerous folded twin', () => {
  const RM = 'rm -rf /';
  const ENV = '/project/.env';
  const COLLIDING = [
    { tool_input: { command: 'echo ok' }, Tool_Input: { command: RM } },
    { Tool_Input: { command: RM }, tool_input: { command: 'echo ok' } },
    { input: { file_path: '/tmp/ok.ts' }, INPUT: { file_path: ENV } },
    { arguments: { command: 'echo ok' }, ARGUMENTS: { command: RM } },
  ];
  for (const payload of COLLIDING) {
    assert.strictEqual(runHook(payload).code, 2, `shadowed: ${JSON.stringify(payload)}`);
  }
});

test('[a3r5] container folding did not widen the container vocabulary', () => {
  for (const payload of [
    { Tool_Inputs: { command: 'rm -rf /' } },
    { my_input: { command: 'rm -rf /' } },
    { arguments_list: { file_path: '/project/.env' } },
  ]) {
    assert.strictEqual(runHook(payload).code, 0, `widened: ${JSON.stringify(payload)}`);
  }
});

test('[a3r5] EVERY rm is judged, not just the first', () => {
  for (const command of [
    'rm harmless.txt && /bin/rm -rf /',
    'rm a.txt; rm -rf /',
    'rm -f a.txt && rm -rf ~',
    'rm one.txt && rm two.txt && RM -rf $HOME',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `only the first rm was judged: ${command}`);
  }
  // Still no false positive when no rm is dangerous.
  for (const command of ['rm a.txt && rm b.txt', 'rm -f tmp.log', 'rm notes.md']) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `false positive: ${command}`);
  }
});

test('[a3r5] env var names are case-SENSITIVE again — codex', () => {
  for (const command of [
    'env=development node app.js',
    'git_config_count=1 git status',
    'ld_preload=./lib.so ./app',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `false positive: ${command}`);
  }
  for (const command of [
    'ENV=/tmp/evil sh -c id',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.gitProxy git push origin main',
    'LD_PRELOAD=/tmp/x.so ls',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2,
      `must still block: ${command}`);
  }
});

test('[a3r5] execName splits on / only — a backslash is not a path separator', () => {
  // `echo my\git push --force` is safe: `my\git` is not the git binary.
  // The Claude twin still asks on this string via its blunt /i regex
  // backstop, which is a pre-existing property of that second layer; this
  // file has no such layer, so the tokenizer fix is observable here.
  for (const command of ['echo my\\git push --force', 'echo a\\rm -rf /']) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `backslash treated as a path separator: ${command}`);
  }
});

test('[a3r5-ceiling] the known-open forms are pinned as OPEN, on purpose — codex', () => {
  // The exact forms named in the CEILING block. This guard is
  // single-layer, so more of them are open here than in enforce.js. If a
  // future round closes one, this goes red and the CEILING block must be
  // updated in the same change rather than silently becoming a lie.
  const KNOWN_OPEN = [
    'echo x$(Git --git-dir=/r push --force origin main)',
    'echo x`Git --git-dir=/r push --force origin main`',
    'echo x$(rm -rf /)',
    'true;Git --git-dir=/r push --force origin main',
    'true&&rm -rf /',
    'cat f|rm -rf /',
    './tools-git push --force origin main',
    "printf x > .e''nv",
  ];
  for (const command of KNOWN_OPEN) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `CEILING says known-open; it now blocks, so update the CEILING block: ${command}`);
  }
});

test('[a3r5] nothing that worked before was weakened — codex', () => {
  for (const command of [
    'git push --force origin main',
    'Git push --force origin main',
    '/usr/bin/git --git-dir=/r push --force origin main',
    'rm -rf /',
    'RM -rf /',
    '/bin/rm -rf /',
    'BASH -c "rm -rf /"',
    'cat .env',
    '/bin/tee /project/.env',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2, `weakened: ${command}`);
  }
  assert.strictEqual(runRaw('[]').code, 2, 'H3 array rejection');
  assert.strictEqual(runRaw('').code, 0, 'empty stdin still allows');
  assert.strictEqual(runHook({ tool_input: { Command: 'rm -rf /' } }).code, 2, 'leaf key folding');
  assert.strictEqual(runHook({ file_path: '/project/.env' }).code, 2, 'symmetric containers');
});

test('[a3r6] the GIT_CONFIG_* pattern matches git, not folklore — codex', () => {
  for (const command of [
    'GIT_CONFIG_NAMED_evil=core.gitProxy=rm git status',
    // Isolated on purpose: pairing COUNT_0 with a real KEY_0 would test
    // two variables at once, and KEY_0 IS honoured.
    'GIT_CONFIG_COUNT_0=1 git status',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0,
      `git ignores this spelling; blocking it is noise: ${command}`);
  }
  for (const command of [
    'GIT_CONFIG=/tmp/evil.cfg git status',
    'GIT_CONFIG_NOSYSTEM=1 git status',
    'GIT_CONFIG_GLOBAL=/tmp/evil.cfg git status',
    'GIT_CONFIG_SYSTEM=/tmp/evil.cfg git status',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=id git status',
  ]) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 2, `must block: ${command}`);
  }
  for (const command of ['git_config=/tmp/x git status', 'git_config_nosystem=1 git status']) {
    assert.strictEqual(runHook({ tool_input: { command } }).code, 0, `false positive: ${command}`);
  }
});
