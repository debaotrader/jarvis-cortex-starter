#!/usr/bin/env node
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const CODEX_HOOK_ADMIN = path.join(REPO_ROOT, 'active', 'skills', 'impeccable', 'scripts', 'hook-admin.mjs');
const CODEX_SKILL = path.join(REPO_ROOT, 'active', 'skills', 'impeccable');
const CLAUDE_SKILL = path.join(REPO_ROOT, 'active', 'claude-skills', 'impeccable');
const BASE_ENV = globalThis.process.env;

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-install-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function symlinkSkill(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
}

test('[impeccable hooks] repairs manifests from Jarvis global skill links in a clean project cwd', () => {
  const root = mkTempDir();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  try {
    fs.mkdirSync(project, { recursive: true });
    symlinkSkill(CODEX_SKILL, path.join(home, '.agents', 'skills', 'impeccable'));
    symlinkSkill(CODEX_SKILL, path.join(home, '.codex', 'skills', 'impeccable'));
    symlinkSkill(CLAUDE_SKILL, path.join(home, '.claude', 'skills', 'impeccable'));

    const r = spawnSync('node', [CODEX_HOOK_ADMIN, 'on'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, BASE_ENV, { HOME: home }),
    });

    assert.strictEqual(r.status, 0, `hook-admin failed:\n${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /Installed or repaired hook manifests for: \.claude, \.agents\./, r.stdout);

    const codexManifest = JSON.parse(fs.readFileSync(path.join(project, '.codex', 'hooks.json'), 'utf8'));
    const codexCommand = codexManifest.hooks.PostToolUse[0].hooks[0].command;
    assert.match(codexCommand, /^node "/, codexCommand);
    assert.match(codexCommand, /active\/skills\/impeccable\/scripts\/hook\.mjs"$/, codexCommand);
    assert.doesNotMatch(codexCommand, /\.agents\/skills\/impeccable/, codexCommand);

    const claudeManifest = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    const claudeCommand = claudeManifest.hooks.PostToolUse[0].hooks[0].command;
    assert.match(claudeCommand, /^node "/, claudeCommand);
    assert.match(claudeCommand, /active\/claude-skills\/impeccable\/scripts\/hook\.mjs"$/, claudeCommand);
    assert.doesNotMatch(claudeCommand, /\.claude\/skills\/impeccable/, claudeCommand);
  } finally {
    rmDir(root);
  }
});

test('[impeccable hooks] repairs stale shared Claude hooks when only global skill links exist', () => {
  const root = mkTempDir();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  try {
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({
      preserved: true,
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [
              {
                type: 'command',
                command: 'node "${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/hook.mjs"',
                timeout: 5,
              },
            ],
          },
        ],
      },
    }, null, 2) + '\n');
    symlinkSkill(CODEX_SKILL, path.join(home, '.agents', 'skills', 'impeccable'));
    symlinkSkill(CLAUDE_SKILL, path.join(home, '.claude', 'skills', 'impeccable'));

    const r = spawnSync('node', [CODEX_HOOK_ADMIN, 'on'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, BASE_ENV, { HOME: home }),
    });

    assert.strictEqual(r.status, 0, `hook-admin failed:\n${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /Installed or repaired hook manifests for: \.claude, \.agents\./, r.stdout);

    const sharedManifest = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(sharedManifest.preserved, true);
    assert.doesNotMatch(JSON.stringify(sharedManifest), /skills\/impeccable\/scripts\/hook\.mjs/);

    const localManifest = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    const claudeCommand = localManifest.hooks.PostToolUse[0].hooks[0].command;
    assert.match(claudeCommand, /^node "/, claudeCommand);
    assert.match(claudeCommand, /active\/claude-skills\/impeccable\/scripts\/hook\.mjs"$/, claudeCommand);
    assert.doesNotMatch(claudeCommand, /\$\{CLAUDE_PROJECT_DIR\}/, claudeCommand);
  } finally {
    rmDir(root);
  }
});

test('[impeccable hooks] Cursor-only global skill writes a resolvable Cursor hook manifest', () => {
  const root = mkTempDir();
  const home = path.join(root, 'home');
  const cursorHome = path.join(root, 'portable-cursor');
  const project = path.join(root, 'project');
  const cursorSkill = path.join(cursorHome, 'skills', 'impeccable');
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(cursorSkill), { recursive: true });
    fs.cpSync(CODEX_SKILL, cursorSkill, { recursive: true });

    const hookAdmin = path.join(cursorSkill, 'scripts', 'hook-admin.mjs');
    const r = spawnSync('node', [hookAdmin, 'on'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, BASE_ENV, { HOME: home, CURSOR_HOME: cursorHome }),
    });

    assert.strictEqual(r.status, 0, `hook-admin failed:\n${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /Installed or repaired hook manifests for: \.cursor\./, r.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.cursor', 'hooks.json'), 'utf8'));
    const command = manifest.hooks.preToolUse[0].command;
    assert.match(command, /^node "/, command);
    const scriptPath = JSON.parse(command.slice('node '.length));
    assert.strictEqual(
      fs.realpathSync(scriptPath),
      fs.realpathSync(path.join(cursorSkill, 'scripts', 'hook-before-edit.mjs')),
    );
    assert.ok(fs.existsSync(scriptPath), `hook command must resolve: ${scriptPath}`);
  } finally {
    rmDir(root);
  }
});
