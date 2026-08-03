#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const UPDATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'update-tools.sh');

function runFixture(invocation, gitRootMode = 'exact') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis update-tools '));

  try {
    const fakeHome = path.join(tmp, 'home with spaces');
    const fakeRoot = path.join(tmp, 'clone with spaces');
    const scriptsDir = path.join(fakeRoot, 'scripts');
    const installedScript = path.join(scriptsDir, 'update-tools.sh');
    const pluginRoot = path.join(tmp, 'plugin with spaces');
    const callLog = path.join(tmp, 'calls.log');
    const bashEnv = path.join(tmp, 'bash-env.sh');

    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'codex', 'agent-skills'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'caveman'), { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(UPDATE_SCRIPT, installedScript);
    fs.chmodSync(installedScript, 0o755);

    const physicalRoot = fs.realpathSync(fakeRoot);
    const parentGitRoot = fs.realpathSync(tmp);
    fs.writeFileSync(bashEnv, `
record_call() { printf '%s\\n' "$*" >> "$CALL_LOG"; }
brew() { record_call "brew $*"; return 0; }
claude() { record_call "claude $*"; return 0; }
rtk() { record_call "rtk $*"; printf '%s\\n' 'rtk test'; }
node() { record_call "node $*"; printf '%s' "$PCAV_STUB"; }
rsync() { record_call "rsync $*"; return 0; }
mkdir() {
  record_call "mkdir $*"
  for target in "$@"; do
    case "$target" in
      -*) ;;
      "$FIXTURE_ROOT_LOGICAL"|"$FIXTURE_ROOT_LOGICAL"/*|"$FIXTURE_ROOT_PHYSICAL"|"$FIXTURE_ROOT_PHYSICAL"/*) ;;
      *) printf '%s\\n' "mkdir escaped fixture: $target" >&2; return 97 ;;
    esac
  done
  command /bin/mkdir "$@"
}
git() {
  record_call "git $*"
  if [ "\${3:-}" = "rev-parse" ]; then
    case "$GIT_ROOT_MODE" in
      exact) printf '%s\\n' "$EXPECTED_CORTEX_ROOT" ;;
      parent) printf '%s\\n' "$PARENT_GIT_ROOT" ;;
      missing) return 1 ;;
    esac
  fi
  return 0
}
`);

    let entrypoint = installedScript;
    if (invocation === 'file-symlink') {
      entrypoint = path.join(tmp, 'update-tools-link.sh');
      fs.symlinkSync(path.relative(tmp, installedScript), entrypoint);
    } else if (invocation === 'directory-symlink') {
      const directoryLink = path.join(tmp, 'scripts-link');
      fs.symlinkSync(scriptsDir, directoryLink);
      entrypoint = path.join(directoryLink, 'update-tools.sh');
    }

    execFileSync('/bin/bash', [entrypoint], {
      cwd: tmp,
      env: {
        HOME: fakeHome,
        PATH: '/usr/bin:/bin',
        BASH_ENV: bashEnv,
        CALL_LOG: callLog,
        PCAV_STUB: pluginRoot,
        GIT_ROOT_MODE: gitRootMode,
        EXPECTED_CORTEX_ROOT: physicalRoot,
        PARENT_GIT_ROOT: parentGitRoot,
        FIXTURE_ROOT_LOGICAL: tmp,
        FIXTURE_ROOT_PHYSICAL: fs.realpathSync(tmp),
      },
      stdio: 'pipe',
    });

    const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n') : [];
    return { calls, cortexRoot: physicalRoot };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function isMutableCortexCall(call, cortexRoot) {
  return (call.startsWith('mkdir ') && call.includes(cortexRoot)) ||
    call.startsWith('rsync ') ||
    /^git .* (?:add|commit|push)(?: |$)/.test(call);
}

for (const invocation of ['direct', 'file-symlink', 'directory-symlink']) {
  test(`[update-tools] gate Git precede sync via ${invocation} em path com espaços`, () => {
    const { calls, cortexRoot } = runFixture(invocation);
    const gitGate = calls.findIndex((call) => call.includes(' rev-parse --show-toplevel'));
    const firstMutation = calls.findIndex((call) => isMutableCortexCall(call, cortexRoot));

    assert.ok(gitGate >= 0, `git gate ausente: ${calls.join('\n')}`);
    assert.ok(firstMutation > gitGate, `mutação ocorreu antes do gate: ${calls.join('\n')}`);
  });
}

for (const gitRootMode of ['parent', 'missing']) {
  test(`[update-tools] bloqueia sync quando Git root é ${gitRootMode}`, () => {
    const { calls, cortexRoot } = runFixture('direct', gitRootMode);

    assert.ok(calls.some((call) => call.includes(' rev-parse --show-toplevel')));
    assert.deepStrictEqual(calls.filter((call) => isMutableCortexCall(call, cortexRoot)), []);
    assert.ok(!calls.some((call) => call.includes(' status --porcelain')));
  });
}
