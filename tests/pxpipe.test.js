#!/usr/bin/env node

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'pxpipe.sh');

function writeCommand(bin, name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);

  writeCommand(
    bin,
    'pxpipe',
    'printf "ANTHROPIC_UPSTREAM=%s\\n" "${ANTHROPIC_UPSTREAM:-}"; printf "PXPIPE_MODELS=%s\\n" "${PXPIPE_MODELS:-}"; printf "pxpipe"; printf " <%s>" "$@"; printf "\\n"'
  );
  writeCommand(
    bin,
    'claude',
    'printf "ANTHROPIC_BASE_URL=%s\\n" "${ANTHROPIC_BASE_URL:-}"; printf "claude"; printf " <%s>" "$@"; printf "\\n"'
  );
  writeCommand(bin, 'launchctl', 'printf "launchctl"; printf " <%s>" "$@"; printf "\\n"');
  writeCommand(bin, 'open', 'printf "open"; printf " <%s>" "$@"; printf "\\n"');
  writeCommand(
    bin,
    'curl',
    `if [ "${'${PXPIPE_TEST_CURL_FAIL:-0}'}" = "1" ]; then exit 22; fi
case "$*" in
  */proxy-stats*)
    printf '%s' '{"requests":7,"compressed_requests":5,"saved_input_tokens":1234,"saved_pct_input_only":44.2,"saved_pct_of_all_spend":21.5,"saved_usd":0.0123}'
    ;;
esac`
  );

  return { root, bin };
}

function run(fx, args, extraEnv = {}) {
  const inheritedEnv = process.env;
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...inheritedEnv,
      ...extraEnv,
      HOME: fx.root,
      PATH: `${fx.bin}:${inheritedEnv.PATH}`,
    },
  });
}

test('[pxpipe] Claude wrapper exports the Anthropic proxy URL', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['claude', '--help'], { PXPIPE_URL: 'http://127.0.0.1:49000' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:49000/);
    assert.match(r.stdout, /claude <--help>/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] start respects an explicit Anthropic upstream override', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['start'], { ANTHROPIC_UPSTREAM: 'https://gateway.example/anthropic' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ANTHROPIC_UPSTREAM=https:\/\/gateway\.example\/anthropic/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] start pins the conservative model allowlist by default', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['start']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^PXPIPE_MODELS=claude-fable-5$/m);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] start rejects every non-Claude model family', () => {
  const fx = fixture();
  try {
    for (const model of [
      'gpt-5.6',
      'GPT-5.6',
      'gpt-5.5-codex',
      'o3',
      'gemini-2.5-pro',
      'claude-fable-5,gpt-5.6',
    ]) {
      const r = run(fx, ['start'], { PXPIPE_MODELS: model });
      assert.strictEqual(r.status, 1, `${model}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Claude-only policy/);
      assert.doesNotMatch(r.stdout, /^pxpipe$/m);
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] start rejects malformed model lists', () => {
  const fx = fixture();
  try {
    for (const models of ['', '   ', ',', 'claude-fable-5,', ',claude-fable-5', 'claude-fable-5,,claude-sonnet-5']) {
      const r = run(fx, ['start'], { PXPIPE_MODELS: models });
      assert.strictEqual(r.status, 1, `${models}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /invalid PXPIPE_MODELS list/);
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] off remains an explicit compression kill switch', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['start'], { PXPIPE_MODELS: 'off' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^PXPIPE_MODELS=off$/m);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] degraded Claude model override is explicit and auditable', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['start'], {
      PXPIPE_MODELS: 'claude-opus-4-8',
      PXPIPE_ALLOW_DEGRADED_MODELS: '1',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /PXPIPE_MODELS=claude-opus-4-8/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] status fails closed when the dashboard is unreachable', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['status'], { PXPIPE_TEST_CURL_FAIL: '1' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /dashboard is not reachable/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] stats prints measured savings from the dashboard', () => {
  const fx = fixture();
  try {
    const r = run(fx, ['stats']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /requests: 7/);
    assert.match(r.stdout, /compressed: 5/);
    assert.match(r.stdout, /saved input tokens: 1,234/);
    assert.match(r.stdout, /input savings: 44\.2%/);
    assert.match(r.stdout, /total spend savings: 21\.5%/);
    assert.match(r.stdout, /estimated savings: \$0\.0123/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] stats preserves cache-aware savings across proxy restarts', () => {
  const fx = fixture();
  try {
    const eventsFile = path.join(fx.root, 'events.jsonl');
    fs.writeFileSync(eventsFile, JSON.stringify({
      status: 200,
      compressed: true,
      baseline_tokens: 55881,
      baseline_cacheable_tokens: 50725,
      input_tokens: 5669,
      cache_create_tokens: 25313,
      cache_read_tokens: 0,
      output_tokens: 18,
    }) + '\n');

    const r = run(fx, ['stats'], {
      PXPIPE_LOG: eventsFile,
      PXPIPE_TEST_CURL_FAIL: '1',
    });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pxpipe stats \(history\)/);
    assert.match(r.stdout, /events: 1/);
    assert.match(r.stdout, /compressed: 1/);
    assert.match(r.stdout, /saved input tokens: 31,252/);
    assert.match(r.stdout, /input savings: 45\.6%/);
    assert.match(r.stdout, /total spend savings: 45\.5%/);
    assert.match(r.stdout, /estimated savings: \$0\.3125/);
    assert.match(r.stdout, /current process requests: 0/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[pxpipe] Claude.app commands set, open, and remove the launch override', () => {
  const fx = fixture();
  try {
    const on = run(fx, ['claude-app-on']);
    assert.strictEqual(on.status, 0, on.stderr);
    assert.match(on.stdout, /launchctl <setenv> <ANTHROPIC_BASE_URL> <http:\/\/127\.0\.0\.1:47821>/);

    const opened = run(fx, ['claude-app-open']);
    assert.strictEqual(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /open <-a> <Claude>/);

    const off = run(fx, ['claude-app-off']);
    assert.strictEqual(off.status, 0, off.stderr);
    assert.match(off.stdout, /launchctl <unsetenv> <ANTHROPIC_BASE_URL>/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
