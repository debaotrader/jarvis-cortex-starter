#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_PATH = path.join(REPO_ROOT, 'codex', 'hooks.json');
const ADAPTER_PATH = path.join(REPO_ROOT, 'scripts', 'rtk-codex-hook.js');
const ADAPTER_COMMAND = 'node "$HOME/.codex/scripts/rtk-codex-hook.js"';

test('[rtk codex] Bash PreToolUse uses the Codex protocol adapter', () => {
  const manifest = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
  const groups = manifest.hooks?.PreToolUse || [];
  const bashGroup = groups.find((group) => group.matcher === 'Bash');

  assert.ok(bashGroup, 'missing Bash-only PreToolUse hook group');
  assert.ok(
    bashGroup.hooks.some((hook) => hook.type === 'command' && hook.command === ADAPTER_COMMAND),
    `missing Codex RTK adapter command: ${ADAPTER_COMMAND}`,
  );
});

test('[rtk codex] adapter emits the complete Codex rewrite contract', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-codex-test-'));
  const fakeRtk = path.join(temp, 'rtk');
  fs.writeFileSync(fakeRtk, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('rtk 0.43.0\\n');
  process.exit(0);
}
fs.readFileSync(0, 'utf8');
process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}\\n');
`);
  fs.chmodSync(fakeRtk, 0o755);

  try {
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    const result = spawnSync('node', [ADAPTER_PATH, fakeRtk], { input, encoding: 'utf8' });

    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(output.hookSpecificOutput.updatedInput.command, 'rtk git status');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
