#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(REPO_ROOT, 'scripts', 'setup-graphify-brain.sh');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-brain-test-'));
  const brain = path.join(home, '.jarvis', 'brain');
  const graphDir = path.join(brain, 'graphify-out');
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'commands.log');
  const claudeState = path.join(home, 'claude-mcp.state');
  const codexState = path.join(home, 'codex-mcp.state');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify({
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [{ id: 'readme_jarvis_brain', label: 'Jarvis Brain' }],
    links: [],
    hyperedges: [],
  }));
  assert.strictEqual(spawnSync('git', ['init', '-q', brain]).status, 0);

  const graphify = path.join(bin, 'graphify');
  fs.writeFileSync(graphify, `#!/usr/bin/env bash
printf 'graphify\t%s\\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = hook ] && [ "\${2:-}" = status ]; then
  if [ "\${HOOK_STATUS_FAIL:-0}" = 1 ]; then exit 7; fi
  if [ "\${HOOK_STATUS_UNEXPECTED:-0}" = 1 ]; then printf 'unknown hook state\n'; exit 0; fi
  if [ "\${HOOKS_INSTALLED:-0}" = 1 ]; then
    printf 'post-commit: installed\\npost-checkout: installed\\n'
  else
    printf 'post-commit: not installed\\npost-checkout: not installed\\n'
  fi
fi
if [ "\${1:-}" = explain ]; then printf 'Node: Jarvis Brain\\n'; fi
exit 0
`);

  const graphifyMcp = path.join(bin, 'graphify-mcp');
  fs.writeFileSync(graphifyMcp, '#!/usr/bin/env bash\nexit 0\n');

  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env bash
printf 'claude\t%s\\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = mcp ] && [ "\${2:-}" = get ]; then
  if [ "\${CLAUDE_MCP_PRESENT:-0}" != 1 ] && [ ! -f "$CLAUDE_MCP_STATE" ]; then exit 1; fi
  printf 'graphify-brain:\\n  Status: Connected\\n  Type: stdio\\n'
  if [ "\${BAD_CLAUDE_MCP:-0}" = 1 ]; then
    printf '  Command: /tmp/other/graphify-mcp\\n  Args: --graph /tmp/other/graph.json\\n'
  elif [ "\${CLAUDE_NEAR_COLLISION:-0}" = 1 ]; then
    printf '  Command: %s-wrapper\\n  Args: --graph %s.bak\\n' "$GRAPHIFY_MCP_BIN" "$TEST_GRAPH_PATH"
  else
    printf '  Command: %s\\n  Args: --graph %s\\n' "$GRAPHIFY_MCP_BIN" "$TEST_GRAPH_PATH"
  fi
  exit 0
fi
if [ "\${1:-}" = mcp ] && [ "\${2:-}" = add ]; then
  if [ "\${CLAUDE_ADD_FAIL:-0}" = 1 ]; then exit 8; fi
  : > "$CLAUDE_MCP_STATE"
  exit 0
fi
if [ "\${1:-}" = mcp ] && [ "\${2:-}" = remove ]; then
  rm -f "$CLAUDE_MCP_STATE"
  exit 0
fi
exit 0
`);

  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/usr/bin/env bash
printf 'codex\t%s\\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = mcp ] && [ "\${2:-}" = get ]; then
  if [ "\${CODEX_MCP_PRESENT:-0}" != 1 ] && [ ! -f "$CODEX_MCP_STATE" ]; then exit 1; fi
  enabled=true
  command="$GRAPHIFY_MCP_BIN"
  graph="$TEST_GRAPH_PATH"
  if [ "\${CODEX_DISABLED:-0}" = 1 ]; then enabled=false; fi
  if [ "\${BAD_CODEX_MCP:-0}" = 1 ]; then
    command="/tmp/other/graphify-mcp"
    graph="/tmp/other/graph.json"
  fi
  if [ "\${CODEX_NEAR_COLLISION:-0}" = 1 ]; then
    command="$GRAPHIFY_MCP_BIN-wrapper"
    graph="$TEST_GRAPH_PATH.bak"
  fi
  printf '{"name":"graphify-brain","enabled":%s,"transport":{"type":"stdio","command":"%s","args":["--graph","%s"]}}\\n' "$enabled" "$command" "$graph"
  if [ "\${CODEX_GET_FAIL:-0}" = 1 ]; then exit 10; fi
  exit 0
fi
if [ "\${1:-}" = mcp ] && [ "\${2:-}" = add ]; then
  if [ "\${CODEX_ADD_FAIL:-0}" = 1 ]; then exit 9; fi
  : > "$CODEX_MCP_STATE"
  exit 0
fi
exit 0
`);

  for (const file of [graphify, graphifyMcp, claude, codex]) fs.chmodSync(file, 0o755);
  return { home, brain, bin, log, claudeState, codexState, graphify, graphifyMcp, claude, codex };
}

function runSetup(fx, args = ['--all'], overrides = {}) {
  return spawnSync('bash', [SETUP, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}:${process.env.PATH}`,
      COMMAND_LOG: fx.log,
      JARVIS_BRAIN_HOME: fx.brain,
      GRAPHIFY_BIN: fx.graphify,
      GRAPHIFY_MCP_BIN: fx.graphifyMcp,
      CLAUDE_BIN: fx.claude,
      CODEX_BIN: fx.codex,
      TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
      CLAUDE_MCP_STATE: fx.claudeState,
      CODEX_MCP_STATE: fx.codexState,
      ...overrides,
    },
  });
}

test('[graphify-brain] registers official MCP in Claude and Codex and disables Git hooks', () => {
  const fx = fixture();
  try {
    const result = runSetup(fx);
    assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const log = fs.readFileSync(fx.log, 'utf8');
    const graph = path.join(fx.brain, 'graphify-out', 'graph.json');
    assert.match(log, /graphify\tclaude install/);
    assert.match(log, /graphify\tcodex install/);
    assert.match(log, /graphify\thook uninstall/);
    assert.match(log, new RegExp(`claude\\tmcp add --scope user graphify-brain -- .* --graph ${graph}`));
    assert.match(log, new RegExp(`codex\\tmcp add graphify-brain -- .* --graph ${graph}`));
    assert.doesNotMatch(log, /mcp remove graphify-brain/);
    const driver = spawnSync('git', ['-C', fx.brain, 'config', '--get', 'merge.graphify.driver'], { encoding: 'utf8' });
    assert.strictEqual(driver.stdout.trim(), `${fx.graphify} merge-driver %O %A %B`);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] setup is idempotent', () => {
  const fx = fixture();
  try {
    assert.strictEqual(runSetup(fx).status, 0);
    assert.strictEqual(runSetup(fx).status, 0);
    const log = fs.readFileSync(fx.log, 'utf8');
    assert.strictEqual((log.match(/claude\tmcp add --scope user graphify-brain/g) || []).length, 1);
    assert.strictEqual((log.match(/codex\tmcp add graphify-brain/g) || []).length, 1);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] near-collision Claude registration is rejected and preserved', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.claudeState, 'existing');
    const result = runSetup(fx, ['--claude'], { CLAUDE_NEAR_COLLISION: '1' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /preserving it/);
    assert.ok(fs.existsSync(fx.claudeState), 'existing Claude registration was removed');
    const log = fs.readFileSync(fx.log, 'utf8');
    assert.doesNotMatch(log, /claude\tmcp (add|remove)/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] failed Codex replacement never removes the existing registration', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.codexState, 'existing');
    const result = runSetup(fx, ['--codex'], { BAD_CODEX_MCP: '1', CODEX_ADD_FAIL: '1' });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(fx.codexState), 'existing Codex registration was removed');
    const log = fs.readFileSync(fx.log, 'utf8');
    assert.match(log, /codex\tmcp add graphify-brain/);
    assert.doesNotMatch(log, /codex\tmcp remove graphify-brain/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] missing graph fails before MCP registration', () => {
  const fx = fixture();
  try {
    fs.rmSync(path.join(fx.brain, 'graphify-out', 'graph.json'));
    const result = runSetup(fx);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /graph missing or empty/);
    assert.ok(!fs.existsSync(fx.log), 'MCP commands ran despite a missing graph');
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] local config resolves graphifyBrainPath without env override', () => {
  const fx = fixture();
  try {
    const claudeHome = path.join(fx.home, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'config.json'), JSON.stringify({ graphifyBrainPath: fx.brain }));
    const result = runSetup(fx, ['--codex'], { JARVIS_BRAIN_HOME: '', CLAUDE_HOME: claudeHome });
    assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`Brain: ${fx.brain}`));
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] malformed Cortex config fails closed without using the default Brain', () => {
  const fx = fixture();
  try {
    const claudeHome = path.join(fx.home, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'config.json'), '{not-json');
    const result = runSetup(fx, ['--codex'], { JARVIS_BRAIN_HOME: '', CLAUDE_HOME: claudeHome });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Cortex config is invalid/);
    assert.ok(!fs.existsSync(fx.log), 'setup continued after malformed Cortex config');
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] setup fails when Graphify hook status cannot be verified', () => {
  const fx = fixture();
  try {
    const result = runSetup(fx, ['--all'], { HOOK_STATUS_FAIL: '1' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Could not verify Graphify Git-hook status/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor validates the real graph and both MCP registrations', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /OK\s+Jarvis Brain graph parses/);
    assert.match(result.stdout, /OK\s+Codex graphify-brain MCP targets the canonical graph/);
    assert.match(result.stdout, /OK\s+Claude Code graphify-brain MCP targets the canonical graph/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor rejects Claude MCP near-collision command and graph', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        CLAUDE_NEAR_COLLISION: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Claude Code graphify-brain MCP missing, unreachable, or misconfigured/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor rejects a disabled Codex MCP registration', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        CODEX_DISABLED: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Codex graphify-brain MCP missing or misconfigured/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor rejects Codex MCP near-collision command and graph', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        CODEX_NEAR_COLLISION: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Codex graphify-brain MCP missing or misconfigured/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor rejects valid Codex JSON returned with a failing exit status', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        CODEX_GET_FAIL: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Codex graphify-brain MCP missing or misconfigured/);
    assert.doesNotMatch(result.stdout, /OK\s+Codex graphify-brain MCP targets the canonical graph/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor rejects an installed code-only hook', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        HOOKS_INSTALLED: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Graphify Git hooks are installed or their status is unrecognized/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor fails when Graphify hook status cannot be read', () => {
  const fx = fixture();
  try {
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: fx.brain,
        GRAPHIFY_MCP_BIN: fx.graphifyMcp,
        TEST_GRAPH_PATH: path.join(fx.brain, 'graphify-out', 'graph.json'),
        HOOK_STATUS_FAIL: '1',
        CLAUDE_MCP_PRESENT: '1',
        CLAUDE_MCP_STATE: fx.claudeState,
        CODEX_MCP_PRESENT: '1',
        CODEX_MCP_STATE: fx.codexState,
        CLAUDE_HOME: path.join(fx.home, '.claude-missing'),
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Graphify Git-hook status check failed in Markdown Brain/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});

test('[graphify-brain] doctor fails closed on malformed Cortex config', () => {
  const fx = fixture();
  try {
    const claudeHome = path.join(fx.home, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'config.json'), '{not-json');
    const result = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fx.home,
        PATH: `${fx.bin}:${process.env.PATH}`,
        JARVIS_BRAIN_HOME: '',
        JARVIS_CORTEX_CONFIG: path.join(claudeHome, 'config.json'),
        JARVIS_BRAIN_OPTIONAL: '1',
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: path.join(fx.home, '.codex-missing'),
      },
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /FAIL\s+Cortex config is invalid/);
    assert.doesNotMatch(result.stdout, /Jarvis Brain not installed/);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
});
