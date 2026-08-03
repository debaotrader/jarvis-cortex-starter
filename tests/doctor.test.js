#!/usr/bin/env node
/**
 * tests/doctor.test.js — testes de detecção do scripts/doctor.sh.
 *
 * doctor.sh é o health check read-only cross-harness do cortex. O smoke test
 * só roda `bash -n` + bit de executável nele; estes testes exercitam a LÓGICA
 * de detecção: se doctor.sh parar de detectar um problema real, um teste aqui
 * quebra.
 *
 * Cada teste é hermético e determinístico:
 *   - monta seu PRÓPRIO fixture num HOME temporário (mkdtempSync), limpo no fim;
 *   - sempre seta HOME + CLAUDE_HOME + CODEX_HOME pro temp (CODEX_HOME aponta
 *     pra um path inexistente → WARN, nunca toca no ~/.codex real);
 *   - roda `bash scripts/doctor.sh` via spawnSync e afere exit code + linhas
 *     específicas de output.
 *
 * Os testes de FAIL aferem a SUBSTRING específica da falha (não só exit 1):
 * se doctor.sh deixar de detectar aquele caso, a substring some e o teste
 * quebra. Exit-code-only seria fraco (outras FAILs incidentais o manteriam 1).
 *
 * Run: node --test tests/doctor.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCTOR = path.join(REPO_ROOT, 'scripts', 'doctor.sh');
const BOOTSTRAP = path.join(REPO_ROOT, 'scripts', 'bootstrap-claude.sh');
const BOOTSTRAP_OPENCODE = path.join(REPO_ROOT, 'scripts', 'bootstrap-opencode.sh');
const INSTALL_CODEX_SKILLS = path.join(REPO_ROOT, 'scripts', 'install-codex-skills.sh');
const CURSOR_MANIFEST_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-skill-manifest.mjs');
const CURSOR_AUDIT_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-skills-audit.mjs');
// O checkout do gstack é código de terceiro, 1.1GB, que ninguém versiona junto.
// Enquanto bastava ele existir, o teste abaixo rodava contra a árvore VIVA sempre
// que estivesse na máquina: resultado, duração e segurança dependendo do host, e
// nada conferindo que a fonte sobreviveu. Agora é opt-in explícito, e quando
// ligado a fonte é conferida byte + modo no fim (realGstackGuard).
// Mesmo tratamento aplicado em tests/bootstrap-cursor.test.js.
const REAL_GSTACK_CURSOR_SKILLS = path.join(os.homedir(), '.gstack', 'repos', 'gstack', '.cursor', 'skills');
const REAL_GSTACK_OPT_IN = process.env.JARVIS_TEST_REAL_GSTACK === '1';
const HAVE_REAL_GSTACK = REAL_GSTACK_OPT_IN && fs.existsSync(REAL_GSTACK_CURSOR_SKILLS);
const REAL_GSTACK_SKIP = REAL_GSTACK_OPT_IN
  ? 'checkout gstack real indisponível'
  : 'checkout gstack real: exporte JARVIS_TEST_REAL_GSTACK=1 para habilitar';

// Fotografa tipo, modo e conteúdo. Rodar uma ferramenta contra árvore de
// terceiro sem conferir que ela sobreviveu é a mesma omissão que deixou o dano
// em cursor/hooks/rtk-shell.js passar: exit code certo, estrago em outro lugar.
function realGstackSnapshot(candidate) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return null;
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return { type: 'link', mode, target: fs.readlinkSync(candidate) };
  if (stat.isDirectory()) {
    return {
      type: 'directory',
      mode,
      entries: Object.fromEntries(fs.readdirSync(candidate).sort()
        .map((entry) => [entry, realGstackSnapshot(path.join(candidate, entry))])),
    };
  }
  return { type: 'file', mode, content: fs.readFileSync(candidate).toString('base64') };
}

function realGstackGuard() {
  const before = realGstackSnapshot(REAL_GSTACK_CURSOR_SKILLS);
  return () => assert.deepStrictEqual(realGstackSnapshot(REAL_GSTACK_CURSOR_SKILLS), before,
    `o checkout real do gstack foi modificado: ${REAL_GSTACK_CURSOR_SKILLS}`);
}
const REPO_SETTINGS = path.join(REPO_ROOT, 'settings.json');
const ORIGINAL_TEST_PATH = process.env.PATH || '';
const TEST_BUN_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-bun-'));
fs.writeFileSync(path.join(TEST_BUN_BIN, 'bun'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(TEST_BUN_BIN, 'bun'), 0o755);
process.env.PATH = `${TEST_BUN_BIN}${path.delimiter}${ORIGINAL_TEST_PATH}`;
process.on('exit', () => fs.rmSync(TEST_BUN_BIN, { recursive: true, force: true }));
const SQLITE_AVAILABLE = spawnSync('sqlite3', ['--version']).status === 0;

function pathWithoutBun(home) {
  const nodeBin = path.join(home, 'no-bun-bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const filtered = ORIGINAL_TEST_PATH.split(path.delimiter).filter((directory) => {
    if (!directory) return false;
    try {
      fs.accessSync(path.join(directory, 'bun'), fs.constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  return [nodeBin, ...filtered].join(path.delimiter);
}

function pathWithoutNode(home) {
  const shellBin = path.join(home, 'no-node-bin');
  fs.mkdirSync(shellBin, { recursive: true });
  const pathEntries = process.env.PATH.split(path.delimiter).filter(Boolean);
  for (const command of [
    'bash', 'sh', 'dirname', 'git', 'grep', 'sed', 'head', 'find', 'cat', 'uname', 'sqlite3',
  ]) {
    const executable = pathEntries
      .map((directory) => path.join(directory, command))
      .find((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (executable) fs.symlinkSync(executable, path.join(shellBin, command));
  }
  const noNodePath = shellBin;
  const missingNode = spawnSync('node', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: noNodePath },
  });
  assert.strictEqual(missingNode.status, null, 'node must be absent from no-node PATH fixture');
  assert.strictEqual(spawnSync('bash', ['-c', 'command -v grep && command -v find'], {
    env: { ...process.env, PATH: noNodePath },
  }).status, 0, 'shell-only dependencies must remain available');
  return noNodePath;
}

// Fresh temp HOME. Caller is responsible for rmSync in finally.
function mkTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
}

function rmHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function cursorThirdPartyFixture(_home, value = 'false') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-doctor-third-party-'));
  const bin = path.join(root, 'bin');
  const stateDb = path.join(root, 'state.vscdb');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(stateDb, 'hermetic sqlite fixture\n');
  const sqlite = path.join(bin, 'sqlite3');
  fs.writeFileSync(sqlite, `#!/bin/sh
case "$*" in
  *cursor/thirdPartyExtensibilityEnabled*) printf '%s\\n' ${JSON.stringify(value)} ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(sqlite, 0o755);
  return {
    stateDb,
    bin,
    path: `${bin}${path.delimiter}${ORIGINAL_TEST_PATH}`,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// The fake sqlite3 must survive a caller-supplied PATH (pathWithoutNode /
// pathWithoutBun). Prefix only the fixture's bin so the hand-picked PATH keeps
// its meaning (no node / no bun) while the fixture sqlite3 still shadows the
// real one — otherwise the real sqlite3 reads the plain-text fixture DB and
// doctor reports the third-party flag as unset.
function composeFixturePath(fixture, callerPath) {
  if (!fixture) return callerPath;
  return callerPath ? `${fixture.bin}${path.delimiter}${callerPath}` : fixture.path;
}

function snapshotDoctorTree(candidate) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { type: 'link', target: fs.readlinkSync(candidate) };
  if (stat.isDirectory()) {
    return {
      type: 'directory',
      entries: Object.fromEntries(
        fs.readdirSync(candidate).sort()
          .map((entry) => [entry, snapshotDoctorTree(path.join(candidate, entry))]),
      ),
    };
  }
  return { type: 'file', mode: stat.mode & 0o777, content: fs.readFileSync(candidate).toString('base64') };
}

// Run bootstrap-claude.sh against `home`, producing a healthy install of
// cortex symlinks under home/.claude. Spread process.env so PATH (→ node)
// survives; override HOME + CLAUDE_HOME at the temp dir.
// INSTALL_MATTPOCOCK=0 skips the github.com/mattpocock/skills clone: doctor.sh
// never inspects those skills (its CLAUDE_HOME checks cover an explicit managed
// list), so cloning them per bootstrap would only make the suite depend on the
// network and blow the spawn timeout offline.
function bootstrap(home, opts = {}) {
  const r = spawnSync('bash', [opts.script || BOOTSTRAP], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_HOME: path.join(home, '.claude'),
      SETUP_GRAPHIFY_BRAIN: '0',
      INSTALL_MATTPOCOCK: '0',
    },
  });
  assert.strictEqual(r.status, 0, `bootstrap-claude.sh failed:\n${r.stderr}\n${r.stdout}`);
}

// Run doctor.sh against `home`. CLAUDE_HOME defaults under home; CODEX_HOME is
// forced to a nonexistent path so the Codex section just WARNs (hermetic — no
// dependence on the real ~/.codex). OPENCODE config derives from HOME, absent
// in a temp HOME → WARN. process.env spread keeps node/git/rtk on PATH.
function runDoctor(home, opts = {}) {
  const thirdPartyFixture = opts.thirdParty === 'db'
    ? null
    : cursorThirdPartyFixture(home, opts.thirdParty ?? 'false');
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_HOME: opts.claudeHome || path.join(home, '.claude'),
    CODEX_HOME: opts.codexHome || path.join(home, '.codex-nonexistent'),
    CURSOR_HOME: opts.cursorHome || path.join(home, '.cursor-nonexistent'),
    GSTACK_REPO_ROOT: opts.gstackRoot || path.join(home, '.gstack', 'repos', 'gstack'),
    AGENTS_TARGET_SKILLS: opts.agentsTargetSkills || path.join(home, '.agents', 'skills'),
    JARVIS_BRAIN_OPTIONAL: '1',
    ...(thirdPartyFixture ? { CURSOR_STATE_DB: thirdPartyFixture.stateDb } : {}),
    ...(opts.cursorStateDb ? { CURSOR_STATE_DB: opts.cursorStateDb } : {}),
    ...(opts.cursorUserDataDir ? { CURSOR_USER_DATA_DIR: opts.cursorUserDataDir } : {}),
    ...(opts.manifestTool ? { CURSOR_MANIFEST_TOOL: opts.manifestTool } : {}),
    ...(composeFixturePath(thirdPartyFixture, opts.path)
      ? { PATH: composeFixturePath(thirdPartyFixture, opts.path) }
      : {}),
  };
  const args = [opts.script || DOCTOR];
  if (opts.rtkBin && opts.codexBin) args.push(opts.rtkBin, opts.codexBin);
  const r = spawnSync('bash', args, { encoding: 'utf8', timeout: 30000, env });
  thirdPartyFixture?.cleanup();
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function installCodexSkills(home) {
  const r = spawnSync('bash', [INSTALL_CODEX_SKILLS], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      AGENTS_TARGET_SKILLS: path.join(home, '.agents', 'skills'),
      INSTALL_GSTACK: '0',
      INSTALL_KARPATHY: '0',
    },
  });
  assert.strictEqual(r.status, 0, 'install-codex-skills.sh failed:\n' + r.stderr + '\n' + r.stdout);
}

function installCodexHarness(home) {
  installCodexSkills(home);
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'AGENTS.md'), path.join(codexHome, 'AGENTS.md'));
  fs.symlinkSync(path.join(REPO_ROOT, 'RTK-codex.md'), path.join(codexHome, 'RTK.md'));
  fs.symlinkSync(path.join(REPO_ROOT, 'codex', 'hooks.json'), path.join(codexHome, 'hooks.json'));
  fs.symlinkSync(
    path.join(REPO_ROOT, 'scripts', 'rtk-codex-hook.js'),
    path.join(codexHome, 'scripts', 'rtk-codex-hook.js'),
  );

  const binDir = path.join(home, 'fake-bin');
  const rtkBin = path.join(binDir, 'rtk');
  const codexBin = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(rtkBin, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  process.stdout.write('rtk 0.43.0\\n');
  process.exit(0);
}
fs.readFileSync(0, 'utf8');
process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}\\n');
`);
  fs.writeFileSync(codexBin, `#!/usr/bin/env node
'use strict';
if (process.argv[2] === 'features' && process.argv[3] === 'list') {
  process.stdout.write('hooks stable true\\n');
  process.exit(0);
}
process.exit(1);
`);
  fs.chmodSync(rtkBin, 0o755);
  fs.chmodSync(codexBin, 0o755);
  return { rtkBin, codexBin };
}

// Run bootstrap-opencode.sh against `home` (global only, no --project so nothing
// lands in the repo cwd). Writes home/.config/opencode/opencode.jsonc whose
// instructions[] point at the real $CORTEX_ROOT files (exist → no FAIL) and
// skills.paths[] include $HOME/.codex/skills etc. (absent in a fresh temp HOME
// → WARN). Hermetic: HOME forced to the temp dir so .config lands there.
function bootstrapOpencode(home) {
  const r = spawnSync('bash', [BOOTSTRAP_OPENCODE], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: home },
  });
  assert.strictEqual(r.status, 0, `bootstrap-opencode.sh failed:\n${r.stderr}\n${r.stdout}`);
}

// Write a real-file settings.json (not a symlink) at home/.claude, derived from
// the repo settings.json, after applying `mutate(obj)`. Used by the fixtures
// that must corrupt/extend settings.json WITHOUT touching the repo file.
function writeSettingsFixture(home, mutate) {
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  const obj = JSON.parse(fs.readFileSync(REPO_SETTINGS, 'utf8'));
  if (mutate) mutate(obj);
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(obj, null, 2));
}

// === 1. HEALTHY → exit 0 ===

test('[doctor] healthy bootstrapped install → exit 0, summary 0 fail', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const r = runDoctor(home);
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
    // statusline + venv WARNs are acceptable in a healthy cold install; the
    // bar is zero FAILs. Match the summary's fail count explicitly.
    assert.match(r.stdout, /doctor: \d+ ok, \d+ warn, 0 fail/, r.stdout);
    assert.doesNotMatch(r.stdout, /^\s*FAIL/m, `unexpected FAIL line:\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] verifies global Impeccable symlinks for Claude, Codex, Agents, and Claude agent', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const toolBins = installCodexHarness(home);

    const r = runDoctor(home, {
      codexHome: path.join(home, '.codex'),
      agentsTargetSkills: path.join(home, '.agents', 'skills'),
      ...toolBins,
    });

    assert.strictEqual(r.code, 0, 'expected exit 0, got ' + r.code + '\n' + r.stdout);
    assert.match(r.stdout, /OK\s+no dangling cortex symlinks under/, r.stdout);
    assert.match(r.stdout, /OK\s+Codex managed links, including the RTK adapter, resolve/, r.stdout);
    assert.match(r.stdout, /OK\s+Agents global Impeccable skill resolves/, r.stdout);
    assert.match(r.stdout, /doctor: \d+ ok, \d+ warn, 0 fail/, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] missing Codex RTK rewrite hook -> FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const toolBins = installCodexHarness(home);

    const hooksPath = path.join(home, '.codex', 'hooks.json');
    const manifest = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    manifest.hooks.PreToolUse = manifest.hooks.PreToolUse.filter((group) => group.matcher !== 'Bash');
    fs.unlinkSync(hooksPath);
    fs.writeFileSync(hooksPath, JSON.stringify(manifest, null, 2));

    const r = runDoctor(home, {
      codexHome: path.join(home, '.codex'),
      agentsTargetSkills: path.join(home, '.agents', 'skills'),
      ...toolBins,
    });

    assert.match(r.stdout, /FAIL\s+Codex automatic RTK hook missing or invalid/, r.stdout);
    assert.strictEqual(r.code, 1, 'expected exit 1, got ' + r.code + '\n' + r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] replaced Codex RTK adapter -> FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const toolBins = installCodexHarness(home);

    const adapterPath = path.join(home, '.codex', 'scripts', 'rtk-codex-hook.js');
    fs.unlinkSync(adapterPath);
    fs.writeFileSync(adapterPath, '#!/usr/bin/env node\nprocess.exit(0);\n');

    const r = runDoctor(home, {
      codexHome: path.join(home, '.codex'),
      agentsTargetSkills: path.join(home, '.agents', 'skills'),
      ...toolBins,
    });

    assert.match(r.stdout, /FAIL\s+Codex RTK adapter points at unexpected target/, r.stdout);
    assert.match(r.stdout, /FAIL\s+Codex hooks or RTK rewrite probe failed/, r.stdout);
    assert.strictEqual(r.code, 1, 'expected exit 1, got ' + r.code + '\n' + r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] missing required Impeccable links -> FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const toolBins = installCodexHarness(home);

    fs.rmSync(path.join(home, '.claude', 'skills', 'impeccable'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.claude', 'agents', 'impeccable-manual-edit-applier.md'), { force: true });
    fs.rmSync(path.join(home, '.codex', 'skills', 'impeccable'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.agents', 'skills', 'impeccable'), { recursive: true, force: true });

    const r = runDoctor(home, {
      codexHome: path.join(home, '.codex'),
      agentsTargetSkills: path.join(home, '.agents', 'skills'),
      ...toolBins,
    });

    assert.match(r.stdout, /FAIL\s+Claude Impeccable skill missing:/, r.stdout);
    assert.match(r.stdout, /FAIL\s+Claude Impeccable helper agent missing:/, r.stdout);
    assert.match(r.stdout, /FAIL\s+Codex Impeccable skill missing:/, r.stdout);
    assert.match(r.stdout, /FAIL\s+Agents global Impeccable skill missing:/, r.stdout);
    assert.strictEqual(r.code, 1, 'expected exit 1, got ' + r.code + '\n' + r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 2. DANGLING SYMLINK → FAIL + exit 1 ===

test('[doctor] dangling managed symlink → FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    // RTK.md is in doctor's `managed` array and symlinked by bootstrap, but is
    // NOT referenced by any settings.json hook — so dangling it yields exactly
    // ONE FAIL (no collateral hook-target FAILs). Replace the symlink in the
    // temp HOME with one pointing at a nonexistent target; never touch the
    // real repo file the original symlink pointed at.
    const link = path.join(home, '.claude', 'RTK.md');
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(home, 'no-such-target'), link);

    const r = runDoctor(home);
    // Specific substring: if the dangling check regresses, this line vanishes.
    assert.match(r.stdout, /FAIL\s+dangling symlink:.*RTK\.md/, r.stdout);
    assert.match(r.stdout, /doctor: \d+ ok, \d+ warn, 1 fail/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] retired mcp-servers path is no longer cortex-managed', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    fs.symlinkSync(path.join(home, 'user-managed-mcp-servers'), path.join(home, '.claude', 'mcp-servers'));

    const r = runDoctor(home);
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /dangling symlink:.*mcp-servers/, r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 3. CORRUPTED settings.json → FAIL + exit 1, fail-closed ===

test('[doctor] invalid-JSON settings.json → JSON FAIL, fail-closed, exit 1', () => {
  const home = mkTempHome();
  try {
    // Real-file settings.json (NOT the repo symlink) with trailing garbage.
    writeSettingsFixture(home);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.appendFileSync(settingsPath, '\n}}}GARBAGE NOT JSON');

    const r = runDoctor(home);
    assert.match(r.stdout, /FAIL\s+settings\.json is not valid JSON/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);

    // Fail-closed: the JSON FAIL must SUPPRESS the downstream sub-check OKs.
    // These negative assertions are the teeth — if the settings_valid guard
    // regresses, the misleading OKs reappear and this test fires.
    assert.doesNotMatch(r.stdout, /OK\s+settings\.json hook commands resolve/, r.stdout);
    assert.doesNotMatch(r.stdout, /OK\s+enabledPlugins are all sourced/, r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 4. ENABLED PLUGIN WITHOUT SOURCE → FAIL + exit 1 ===

test('[doctor] enabledPlugin without source → FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    // Add an enabled plugin whose marketplace is neither in
    // extraKnownMarketplaces nor cached under plugins/cache/.
    writeSettingsFixture(home, (s) => {
      s.enabledPlugins = s.enabledPlugins || {};
      s.enabledPlugins['ghostplugin@ghostmarket'] = true;
    });

    const r = runDoctor(home);
    assert.match(
      r.stdout,
      /FAIL\s+plugin 'ghostplugin@ghostmarket' enabled but has no source/,
      r.stdout
    );
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

// === 5. MISSING HOOK TARGET → FAIL + exit 1 ===

test('[doctor] hook command target missing → FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    // A hook command pointing at a $CLAUDE_HOME path that does not exist.
    writeSettingsFixture(home, (s) => {
      s.hooks = {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node "$CLAUDE_HOME/does-not-exist/ghost.js"' },
            ],
          },
        ],
      };
    });

    const r = runDoctor(home);
    assert.match(
      r.stdout,
      /FAIL\s+hook command target missing:.*does-not-exist\/ghost\.js/,
      r.stdout
    );
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

// === 6. OPENCODE skills.paths MISSING → WARN, exit 0 (WARN must not flip exit) ===

test('[doctor] opencode skills.paths missing → WARN, no FAIL, exit 0', () => {
  const home = mkTempHome();
  try {
    // Healthy CLAUDE install so its section is clean; CODEX_HOME is forced
    // nonexistent by runDoctor (WARN only). Then a real opencode.jsonc: its
    // instructions[] point at real $CORTEX_ROOT files (resolve → no FAIL),
    // while skills.paths[] ($HOME/.codex/skills etc.) are absent in this fresh
    // temp HOME → WARN. This isolates the opencode skills.paths WARN behavior:
    // the exit-0 assertion is meaningful because no other section can FAIL.
    bootstrap(home);
    bootstrapOpencode(home);

    const r = runDoctor(home);
    // Specific WARN substring (prefix, not a coincidental path): if the
    // skills.paths check regresses to silence or to FAIL, this vanishes.
    assert.match(r.stdout, /WARN\s+opencode skills\.paths entry missing:/, r.stdout);
    // The OPENCODE section must NOT FAIL on a missing skills dir...
    assert.doesNotMatch(r.stdout, /FAIL\s+opencode/, r.stdout);
    // ...and a WARN must never flip the overall exit. Both the summary's fail
    // count and the process exit code prove it.
    assert.match(r.stdout, /doctor: \d+ ok, \d+ warn, 0 fail/, r.stdout);
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

// === 7. OPENCODE instructions path MISSING → FAIL + exit 1 ===

test('[doctor] opencode instructions path missing → FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    // Healthy CLAUDE install so the ONLY FAIL is the opencode one (the teeth:
    // exit 1 alone is weak — collateral FAILs would also yield 1 — so we assert
    // the specific opencode instructions substring). Hand-write a minimal
    // opencode.jsonc with the jarvis-managed markers (doctor strips full-line
    // // comments before JSON.parse) and an instructions[] entry pointing at a
    // path that does not exist. STRICT JSON after comment-strip: markers on
    // their own lines, NO trailing commas, NO inline // — else doctor emits the
    // unrelated "not parseable" FAIL instead.
    bootstrap(home);
    const ocDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(ocDir, { recursive: true });
    const ghost = path.join(home, 'no-such-instruction.md');
    const jsonc = [
      '{',
      '// >>> jarvis-managed (regenerated by bootstrap-opencode.sh)',
      '  "instructions": [',
      `    ${JSON.stringify(ghost)}`,
      '  ]',
      '// <<< jarvis-managed',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ocDir, 'opencode.jsonc'), jsonc);

    const r = runDoctor(home);
    // Specific FAIL substring: if the instructions-missing check regresses,
    // this line vanishes even though exit may stay 1 for other reasons.
    assert.match(
      r.stdout,
      /FAIL\s+opencode instructions path missing:.*no-such-instruction\.md/,
      r.stdout
    );
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

// === CURSOR harness ===

const BOOTSTRAP_CURSOR = path.join(REPO_ROOT, 'scripts', 'bootstrap-cursor.sh');

function bootstrapCursor(home, opts = {}) {
  const thirdPartyFixture = opts.thirdParty === 'db'
    ? null
    : cursorThirdPartyFixture(home, opts.thirdParty ?? 'false');
  const target = opts.cursorHome || path.join(home, 'cursor-home');
  const r = spawnSync('bash', [opts.script || BOOTSTRAP_CURSOR], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      CURSOR_HOME: target,
      GSTACK_REPO_ROOT: opts.gstackRoot || path.join(home, '.gstack', 'repos', 'gstack'),
      JARVIS_BRAIN_HOME: path.join(home, '.jarvis-brain-absent'),
      ...(composeFixturePath(thirdPartyFixture, opts.path)
        ? { PATH: composeFixturePath(thirdPartyFixture, opts.path) }
        : {}),
      ...(thirdPartyFixture ? { CURSOR_STATE_DB: thirdPartyFixture.stateDb } : {}),
      ...(opts.cursorStateDb ? { CURSOR_STATE_DB: opts.cursorStateDb } : {}),
      ...(opts.cursorUserDataDir ? { CURSOR_USER_DATA_DIR: opts.cursorUserDataDir } : {}),
    },
  });
  thirdPartyFixture?.cleanup();
  if (!opts.allowFailure) {
    assert.strictEqual(r.status, 0, `bootstrap-cursor.sh failed:\n${r.stderr}\n${r.stdout}`);
  }
  return r;
}

function copyCortexFixture(target) {
  fs.cpSync(REPO_ROOT, target, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REPO_ROOT, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`);
    },
  });
}

function corruptDoctorLinkSource(repoRoot, outsideRoot, variant) {
  const skill = path.join(repoRoot, 'active', 'skills', 'dead-code-audit');
  if (variant === 'source-directory') {
    const external = path.join(outsideRoot, 'external-doctor-dead-code-audit');
    fs.renameSync(skill, external);
    fs.symlinkSync(external, skill);
    return { external, restore() { fs.unlinkSync(skill); fs.renameSync(external, skill); } };
  }
  if (variant === 'intermediate-directory') {
    const skills = path.dirname(skill);
    const external = path.join(outsideRoot, 'external-doctor-active-skills');
    fs.renameSync(skills, external);
    fs.symlinkSync(external, skills);
    return { external, restore() { fs.unlinkSync(skills); fs.renameSync(external, skills); } };
  }
  const skillFile = path.join(skill, 'SKILL.md');
  const external = path.join(outsideRoot, 'external-doctor-dead-code-audit-SKILL.md');
  fs.renameSync(skillFile, external);
  fs.symlinkSync(external, skillFile);
  return { external, restore() { fs.unlinkSync(skillFile); fs.renameSync(external, skillFile); } };
}

function createDoctorGstackFixture(gstackRoot, names) {
  for (const asset of [
    'bin', 'browse/dist', 'browse/bin', 'design/dist', 'extension', 'gstack-upgrade',
    'lib', 'plan-ceo-review', 'plan-devex-review', 'review',
  ]) fs.mkdirSync(path.join(gstackRoot, asset), { recursive: true });
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-config'), '#!/bin/sh\nprintf "true\\n"\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-config'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-update-check'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-update-check'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-review-read'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-review-read'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'browse', 'dist', 'browse'), 'fixture\n');
  fs.chmodSync(path.join(gstackRoot, 'browse', 'dist', 'browse'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'browse', 'bin', 'remote-slug'), 'fixture\n');
  fs.chmodSync(path.join(gstackRoot, 'browse', 'bin', 'remote-slug'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'design', 'dist', 'design'), 'fixture\n');
  fs.chmodSync(path.join(gstackRoot, 'design', 'dist', 'design'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'extension', 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(gstackRoot, 'gstack-upgrade', 'SKILL.md'), '---\nname: gstack-upgrade\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(gstackRoot, 'lib', 'redact-audit-log.ts'), 'export {};\n');
  fs.writeFileSync(path.join(gstackRoot, 'plan-ceo-review', 'SKILL.md'), '---\nname: plan-ceo-review\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(gstackRoot, 'plan-devex-review', 'dx-hall-of-fame.md'), '# DX\n');
  fs.writeFileSync(path.join(gstackRoot, 'ETHOS.md'), '# ETHOS\n');
  fs.writeFileSync(path.join(gstackRoot, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(gstackRoot, 'review', 'checklist.md'), '# Checklist\n');
  fs.writeFileSync(path.join(gstackRoot, 'review', 'TODOS-format.md'), '# TODO format\n');
  for (const entry of names) {
    const sourceLeaf = typeof entry === 'string' ? entry : entry.sourceLeaf;
    const name = typeof entry === 'string' ? entry : entry.name;
    assert.match(sourceLeaf, /^gstack(?:-|$)/, 'fixture source leaf must model the gstack catalog');
    assert.match(name, /^[A-Za-z0-9._-]+$/, 'fixture target/frontmatter name must be explicit');
    const source = path.join(gstackRoot, '.cursor', 'skills', sourceLeaf);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), [
      '---', `name: ${name}`, 'description: fixture', '---',
      '```bash',
      'GSTACK_ROOT="$HOME/.cursor/skills/gstack"',
      'GSTACK_BIN="$GSTACK_ROOT/bin"',
      'GSTACK_BROWSE="$GSTACK_ROOT/browse/dist"',
      'GSTACK_DESIGN="$GSTACK_ROOT/design/dist"',
      '$GSTACK_BIN/gstack-update-check',
      '$GSTACK_BIN/gstack-config get proactive',
      '$GSTACK_BIN/gstack-review-read',
      '$GSTACK_BROWSE/browse',
      '$GSTACK_DESIGN/design',
      '$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md',
      '~/.cursor/skills/gstack/plan-ceo-review/SKILL.md',
      '$HOME/.cursor/skills/gstack/lib/redact-audit-log.ts',
      '${HOME}/.cursor/skills/gstack/extension/manifest.json',
      '$GSTACK_ROOT/review/checklist.md',
      '```',
      '',
    ].join('\n'));
  }
}

test('[doctor] cursor bootstrapped → CURSOR harness OK, exit 0', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
    assert.match(r.stdout, /CURSOR harness/, r.stdout);
    assert.match(r.stdout, /OK\s+Cursor permissions are unrestricted for terminal and MCP/, r.stdout);
    assert.match(
      r.stdout,
      /OK\s+Cursor mcp\.json has the exact managed graphify-brain configuration/,
      r.stdout,
    );
    assert.match(r.stdout, /OK\s+Cursor native skill manifest resolves with exact provenance/, r.stdout);
    assert.match(r.stdout, /OK\s+no backup skill trees under Cursor skills/, r.stdout);
    assert.match(r.stdout, /OK\s+Cursor native skill names are unique recursively/, r.stdout);
    assert.match(r.stdout, /OK\s+Cursor third-party imports are explicitly disabled/, r.stdout);
    assert.doesNotMatch(r.stdout, /FAIL\s+Cursor/, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] graphify-brain exige JSON estrutural e configuração gerenciada exata', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cursor', 'mcp.json'), 'utf8'))
    .mcpServers['graphify-brain'];
  const secretCanary = 'DO_NOT_LOG_MCP_SECRET';
  const variants = [
    {
      name: 'malformed',
      write(mcpPath) { fs.writeFileSync(mcpPath, `{"privateNote":"${secretCanary}"`); },
      failure: /FAIL\s+Cursor mcp\.json is not parseable/,
    },
    {
      name: 'homonym outside mcpServers',
      write(mcpPath) {
        fs.writeFileSync(mcpPath, JSON.stringify({
          metadata: { 'graphify-brain': expected, privateNote: secretCanary },
          mcpServers: { personal: { command: 'echo' } },
        }, null, 2));
      },
      failure: /FAIL\s+Cursor mcp\.json missing graphify-brain under mcpServers/,
    },
    {
      name: 'wrong managed object',
      write(mcpPath) {
        fs.writeFileSync(mcpPath, JSON.stringify({
          privateNote: secretCanary,
          mcpServers: {
            'graphify-brain': { command: 'echo', args: ['wrong-graph'] },
          },
        }, null, 2));
      },
      failure: /FAIL\s+Cursor mcp\.json graphify-brain differs from the managed configuration/,
    },
  ];

  for (const variant of variants) {
    const home = mkTempHome();
    try {
      bootstrap(home);
      bootstrapCursor(home);
      const ch = path.join(home, 'cursor-home');
      variant.write(path.join(ch, 'mcp.json'));
      const result = runDoctor(home, { cursorHome: ch });
      assert.match(result.stdout, variant.failure, `${variant.name}\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /OK\s+Cursor mcp\.json has the exact managed/, result.stdout);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretCanary));
      assert.strictEqual(result.code, 1, `${variant.name}\n${result.stdout}`);
    } finally {
      rmHome(home);
    }
  }
});

test('[doctor] Cursor parcialmente removido continua detectado e falha fechado', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const ch = path.join(home, 'cursor-home');
    fs.unlinkSync(path.join(ch, 'rules', 'jarvis-cortex.mdc'));
    fs.writeFileSync(path.join(ch, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: './hooks/personal.js' }] },
    }, null, 2));
    fs.writeFileSync(path.join(ch, 'mcp.json'), JSON.stringify({
      mcpServers: { personal: { command: 'echo' } },
    }, null, 2));

    const result = runDoctor(home, { cursorHome: ch });
    assert.match(result.stdout, /CURSOR harness \(/, result.stdout);
    assert.doesNotMatch(result.stdout, /WARN\s+Cursor harness not found/, result.stdout);
    assert.match(
      result.stdout,
      /FAIL\s+Cursor hooks\.json missing jarvis hook under sessionStart: \.\/hooks\/session-start\.js/,
      result.stdout,
    );
    assert.match(
      result.stdout,
      /FAIL\s+Cursor mcp\.json missing graphify-brain/,
      result.stdout,
    );
    assert.match(
      result.stdout,
      /FAIL\s+Cursor jarvis-cortex rule missing/,
      result.stdout,
    );
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] runtime root ou managed skill marker residual detectam harness parcial', () => {
  const variants = [
    {
      name: 'runtime root',
      create(ch) { fs.mkdirSync(path.join(ch, 'jarvis-runtime'), { recursive: true }); },
    },
    {
      name: 'managed skill marker',
      create(ch) {
        const skill = path.join(ch, 'skills', 'stale-managed');
        fs.mkdirSync(skill, { recursive: true });
        fs.writeFileSync(path.join(skill, '.jarvis-cortex-skill.json'), '{}\n');
      },
    },
  ];

  for (const variant of variants) {
    const home = mkTempHome();
    try {
      const ch = path.join(home, 'cursor-home');
      variant.create(ch);
      const result = runDoctor(home, { cursorHome: ch });
      assert.match(result.stdout, /CURSOR harness \(/, `${variant.name}\n${result.stdout}`);
      assert.doesNotMatch(
        result.stdout,
        /WARN\s+Cursor harness not found/,
        `${variant.name}\n${result.stdout}`,
      );
      assert.match(
        result.stdout,
        /FAIL\s+Cursor managed roots or fixed destinations are unsafe/,
        `${variant.name}\n${result.stdout}`,
      );
      assert.strictEqual(result.code, 1, `${variant.name}\n${result.stdout}`);
    } finally {
      rmHome(home);
    }
  }
});

test('[doctor] Cursor detectado sem Node falha mas mantém checks shell-safe', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const ch = path.join(home, 'cursor-home');
    const result = runDoctor(home, {
      cursorHome: ch,
      path: pathWithoutNode(home),
    });
    assert.match(result.stdout, /FAIL\s+node not on PATH/, result.stdout);
    assert.match(
      result.stdout,
      /FAIL\s+Cursor harness detected but Node\.js is unavailable/,
      result.stdout,
    );
    assert.match(
      result.stdout,
      /OK\s+Cursor managed roots are real directories \(shell fallback\)/,
      result.stdout,
    );
    assert.match(
      result.stdout,
      /OK\s+Cursor third-party imports are explicitly disabled/,
      result.stdout,
    );
    assert.match(
      result.stdout,
      /FAIL\s+Cursor mcp\.json cannot be verified without Node\.js/,
      result.stdout,
    );
    assert.doesNotMatch(result.stdout, /OK\s+Cursor mcp\.json.*graphify-brain/, result.stdout);
    assert.doesNotMatch(result.stdout, /WARN\s+Cursor harness not found/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] fronteira Cursor falha para roots/files symlinkados e modos graváveis', () => {
  const variants = [
    {
      name: 'hooks root symlink',
      corrupt(ch, external) {
        fs.rmSync(path.join(ch, 'hooks'), { recursive: true });
        fs.symlinkSync(external, path.join(ch, 'hooks'));
      },
    },
    {
      name: 'rules root symlink',
      corrupt(ch, external) {
        fs.rmSync(path.join(ch, 'rules'), { recursive: true });
        fs.symlinkSync(external, path.join(ch, 'rules'));
      },
    },
    {
      name: 'runtime root symlink',
      corrupt(ch, external) {
        fs.rmSync(path.join(ch, 'jarvis-runtime'), { recursive: true });
        fs.symlinkSync(external, path.join(ch, 'jarvis-runtime'));
      },
    },
    {
      name: 'hooks config symlink',
      corrupt(ch, external) {
        fs.unlinkSync(path.join(ch, 'hooks.json'));
        fs.symlinkSync(path.join(external, 'sentinel.json'), path.join(ch, 'hooks.json'));
      },
    },
    {
      name: 'managed hook symlink externo',
      corrupt(ch, external) {
        fs.unlinkSync(path.join(ch, 'hooks', 'rtk-shell.js'));
        fs.symlinkSync(path.join(external, 'sentinel.json'), path.join(ch, 'hooks', 'rtk-shell.js'));
      },
    },
    {
      name: 'hooks root group-writable',
      corrupt(ch) { fs.chmodSync(path.join(ch, 'hooks'), 0o770); },
    },
    {
      name: 'mcp config world-writable',
      corrupt(ch) { fs.chmodSync(path.join(ch, 'mcp.json'), 0o666); },
    },
  ];

  for (const variant of variants) {
    const home = mkTempHome();
    try {
      bootstrap(home);
      bootstrapCursor(home);
      const ch = path.join(home, 'cursor-home');
      const external = path.join(home, 'external-target');
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, 'sentinel.json'), '{"preserve":true}\n');
      const beforeExternal = fs.readFileSync(path.join(external, 'sentinel.json'), 'utf8');
      variant.corrupt(ch, external);

      const result = runDoctor(home, { cursorHome: ch });
      assert.match(
        result.stdout,
        /FAIL\s+Cursor managed roots or fixed destinations are unsafe/,
        `${variant.name}\n${result.stdout}`,
      );
      assert.strictEqual(result.code, 1, `${variant.name}\n${result.stdout}`);
      assert.strictEqual(fs.readFileSync(path.join(external, 'sentinel.json'), 'utf8'), beforeExternal);
    } finally {
      rmHome(home);
    }
  }
});

test('[doctor] verify exige symlink exato em cada hook, rule e permissions fixos', () => {
  const fixed = [
    ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
    ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
    ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
    ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
    ['permissions.json', 'cursor/permissions.json'],
  ];
  for (const mode of ['regular-content', 'different-symlink']) {
    for (const [destination, source] of fixed) {
      const home = mkTempHome();
      try {
        const ch = path.join(home, 'cursor-home');
        bootstrapCursor(home, { cursorHome: ch });
        const target = path.join(ch, destination);
        fs.unlinkSync(target);
        let external;
        let externalBefore;
        if (mode === 'regular-content') {
          fs.writeFileSync(target, `substituted fixed file: ${destination}\n`, { mode: 0o600 });
        } else {
          external = path.join(home, `external-${path.basename(destination)}`);
          fs.copyFileSync(path.join(REPO_ROOT, source), external);
          externalBefore = fs.readFileSync(external);
          fs.symlinkSync(external, target);
        }

        const result = runDoctor(home, { cursorHome: ch });
        assert.match(
          result.stdout,
          /FAIL\s+Cursor managed roots or fixed destinations are unsafe/,
          `${mode} ${destination}\n${result.stdout}`,
        );
        assert.strictEqual(result.code, 1, `${mode} ${destination}\n${result.stdout}`);
        if (external) assert.deepStrictEqual(fs.readFileSync(external), externalBefore);
      } finally {
        rmHome(home);
      }
    }
  }
});

test('[doctor] fixed links rejeitam aliases lexicais em hooks, rule e permissions', () => {
  const fixed = [
    ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
    ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
    ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
    ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
    ['permissions.json', 'cursor/permissions.json'],
  ];
  const aliases = new Map([
    ['dot component', (target, expected) =>
      `./${path.relative(fs.realpathSync(path.dirname(target)), expected)}`],
    ['parent component', (_target, expected) => {
      const parent = path.dirname(expected);
      return `${parent}/../${path.basename(parent)}/${path.basename(expected)}`;
    }],
    ['duplicate slash', (_target, expected) => `${path.dirname(expected)}//${path.basename(expected)}`],
  ]);
  for (const [label, spelling] of aliases) {
    const home = mkTempHome();
    try {
      const ch = path.join(home, 'cursor-home');
      bootstrapCursor(home, { cursorHome: ch });
      for (const [destination, source] of fixed) {
        const target = path.join(ch, destination);
        const expected = path.join(REPO_ROOT, source);
        fs.unlinkSync(target);
        fs.symlinkSync(spelling(target, expected), target);
      }
      const result = runDoctor(home, { cursorHome: ch });
      assert.match(result.stdout, /FAIL\s+Cursor managed roots or fixed destinations are unsafe/,
        `${label}\n${result.stdout}`);
      assert.strictEqual(result.code, 1, `${label}\n${result.stdout}`);
    } finally {
      rmHome(home);
    }
  }
});

test('[doctor] fronteira Cursor falha com intermediário user-controlled 0777', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const parent = path.join(home, 'cursor-parent');
    const ch = path.join(parent, 'cursor-home');
    fs.mkdirSync(parent);
    bootstrapCursor(home, { cursorHome: ch });
    fs.chmodSync(parent, 0o777);

    const result = runDoctor(home, { cursorHome: ch });
    assert.match(result.stdout, /FAIL\s+Cursor managed roots or fixed destinations are unsafe/);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] gstack exige Bun no PATH, harness sem gstack não', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const noBunPath = pathWithoutBun(home);
    const chWithout = path.join(home, 'cursor-without-gstack');
    bootstrapCursor(home, { cursorHome: chWithout });
    const without = runDoctor(home, { cursorHome: chWithout, path: noBunPath });
    assert.doesNotMatch(without.stdout, /Bun executable missing for Cursor gstack skills/);
    assert.strictEqual(without.code, 0, without.stdout);

    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    const chWith = path.join(home, 'cursor-with-gstack');
    bootstrapCursor(home, { cursorHome: chWith, gstackRoot });
    const withGstack = runDoctor(home, {
      cursorHome: chWith,
      gstackRoot,
      path: noBunPath,
    });
    assert.match(withGstack.stdout, /FAIL\s+Bun executable missing for Cursor gstack skills/);
    assert.strictEqual(withGstack.code, 1, withGstack.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] runtime marker symlink externo nunca prova ownership nem sofre mutação', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    const ch = path.join(home, 'cursor-home');
    bootstrapCursor(home, { cursorHome: ch, gstackRoot });
    const runtime = path.join(ch, 'jarvis-runtime', 'gstack');
    const marker = path.join(runtime, '.jarvis-cortex-runtime.json');
    const external = path.join(home, 'external-runtime-marker.json');
    fs.writeFileSync(external, fs.readFileSync(marker), { mode: 0o600 });
    fs.unlinkSync(marker);
    fs.symlinkSync(external, marker);
    const beforeExternal = fs.readFileSync(external);
    const beforeEntries = fs.readdirSync(runtime).sort();

    const result = runDoctor(home, { cursorHome: ch, gstackRoot });
    assert.match(
      result.stdout,
      /FAIL\s+Cursor gstack runtime wrapper is misplaced or has unexpected provenance/,
      result.stdout,
    );
    assert.strictEqual(result.code, 1, result.stdout);
    assert.deepStrictEqual(fs.readFileSync(external), beforeExternal);
    assert.deepStrictEqual(fs.readdirSync(runtime).sort(), beforeEntries);
    assert.strictEqual(fs.readlinkSync(marker), external);
  } finally {
    rmHome(home);
  }
});

test('[doctor] backup com SKILL.md sob Cursor skills → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const backup = path.join(home, 'cursor-home', 'skills', '.backups', 'old-skill');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'SKILL.md'), '---\nname: old-skill\ndescription: backup\n---\n');

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+backup skill trees under Cursor skills/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] Cursor skills root symlink → FAIL explícito', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const external = path.join(home, 'external-skills');
    fs.rmSync(skills, { recursive: true, force: true });
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(external, skills);

    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(result.stdout, /FAIL\s+Cursor managed roots or fixed destinations are unsafe/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] CURSOR_HOME symlink com harness instalado → FAIL explícito', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const realCursorHome = path.join(home, 'real-cursor-home');
    bootstrapCursor(home, { cursorHome: realCursorHome });
    const linkedCursorHome = path.join(home, 'cursor-home-link');
    fs.symlinkSync(realCursorHome, linkedCursorHome);

    const result = runDoctor(home, { cursorHome: linkedCursorHome });
    assert.match(result.stdout, /FAIL\s+Cursor managed roots or fixed destinations are unsafe/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] symlink archive para destino real .backups → FAIL sem duplicata', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const archived = path.join(home, 'external', '.backups', 'unique-archive');
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(
      path.join(archived, 'SKILL.md'),
      '---\nname: unique-archived-skill\ndescription: archived\n---\n',
    );
    fs.symlinkSync(path.dirname(archived), path.join(skills, 'archive'));

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.deepStrictEqual(audit.backups, [path.join('archive', 'unique-archive', 'SKILL.md')]);
    assert.deepStrictEqual(audit.duplicates, []);

    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(result.stdout, /FAIL\s+backup skill trees under Cursor skills \(1 SKILL\.md\)/, result.stdout);
    assert.doesNotMatch(result.stdout, /FAIL\s+duplicate Cursor native skill names/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] nomes duplicados sob Cursor skills → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    for (const dir of ['duplicate-a', path.join('nested', 'duplicate-b')]) {
      const target = path.join(skills, dir);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: duplicated\ndescription: duplicate\n---\n');
    }

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+duplicate Cursor native skill names: duplicated/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor usa escalares YAML para nomes e comentários não mascaram duplicatas', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const fixtures = new Map([
      ['plain-a', 'duplicate'],
      ['quoted-comment', '"duplicate" # comment'],
      ['single-quoted', "'single''quote' # outside"],
      ['double-quoted', '"double\\u002dname" # outside'],
      ['plain-hash', 'hash#literal'],
    ]);
    for (const [directory, scalar] of fixtures) {
      const target = path.join(skills, directory);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: ${scalar}\ndescription: yaml scalar\n---\n`);
    }

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.deepStrictEqual(
      audit.duplicates.find(({ name }) => name === 'duplicate'),
      { name: 'duplicate', paths: [path.join('plain-a', 'SKILL.md'), path.join('quoted-comment', 'SKILL.md')] },
    );
    const names = new Set(audit.skills.map(({ name }) => name));
    for (const name of ["single'quote", 'double-name', 'hash#literal']) assert.ok(names.has(name), name);

    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(result.stdout, /FAIL\s+duplicate Cursor native skill names: duplicate/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor YAML usa só espaço ASCII para indentação, separação e comentários', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const fixtures = new Map([
      ['baseline', 'name: duplicate'],
      ['nbsp-separator', 'name:\u00a0duplicate'],
      ['em-space-separator', 'name:\u2003duplicate'],
      ['nbsp-value-prefix', 'name: \u00a0duplicate'],
      ['em-space-value-prefix', 'name: \u2003duplicate'],
      ['nbsp-comment-prefix', '\u00a0# not a YAML comment\nname: hidden-nbsp'],
      ['em-space-comment-prefix', '\u2003# not a YAML comment\nname: hidden-em-space'],
      ['quoted-nbsp-content', 'name: "duplicate\u00a0"'],
      ['quoted-em-space-content', 'name: "duplicate\u2003"'],
    ]);
    for (const [directory, metadata] of fixtures) {
      const target = path.join(skills, directory);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), `---\n${metadata}\ndescription: unicode YAML boundary\n---\n`);
    }

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    const unicodeInvalid = [...fixtures.keys()].filter((name) =>
      !['baseline', 'quoted-nbsp-content', 'quoted-em-space-content'].includes(name));
    assert.deepStrictEqual(
      audit.errors.map(({ path: skillPath }) => skillPath).filter((skillPath) =>
        unicodeInvalid.some((directory) => skillPath === path.join(directory, 'SKILL.md'))),
      unicodeInvalid.sort().map((directory) => path.join(directory, 'SKILL.md')),
      JSON.stringify(audit.errors),
    );
    assert.ok(audit.errors.filter(({ path: skillPath }) =>
      unicodeInvalid.some((directory) => skillPath === path.join(directory, 'SKILL.md')))
      .every(({ code }) => typeof code === 'string' && code.length > 0));
    assert.ok(!audit.duplicates.some(({ name }) => name === 'duplicate'), JSON.stringify(audit.duplicates));
    const names = new Set(audit.skills.map(({ name }) => name));
    assert.ok(names.has('duplicate'));
    assert.ok(names.has('duplicate\u00a0'), 'quoted NBSP must remain scalar content');
    assert.ok(names.has('duplicate\u2003'), 'quoted EM SPACE must remain scalar content');
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor rejeita todo YAML 1.2 Core plain não-string e preserva quoted strings', () => {
  const home = mkTempHome();
  try {
    const skills = path.join(home, 'skills');
    fs.mkdirSync(skills);
    const coreNonStrings = [
      '~', 'null', 'Null', 'NULL', 'true', 'True', 'FALSE',
      '0', '+0', '-0', '00', '+01', '-01', '123',
      '0o17', '+0o17', '-0o17', '0xFF', '+0x1a', '-0x2A',
      '.5', '+.5', '-.5', '00.5', '-00.5', '1.', '1e3', '01E+2', '-2e-4',
      '.inf', '.Inf', '+.INF', '-.inf', '.nan', '.NaN', '.NAN',
    ];
    coreNonStrings.forEach((scalar, index) => {
      for (const [kind, rendered] of [
        ['plain', scalar],
        ['quoted', JSON.stringify(scalar)],
      ]) {
        const target = path.join(skills, `${kind}-${index}`);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'SKILL.md'),
          `---\nname: ${rendered}\ndescription: YAML Core ${kind}\n---\n`);
      }
    });
    const coreStrings = ['0b101', '1_000', 'tRuE', 'nUlL', '0O17', '0Xff', '.iNf', '.nAn', '-.nan'];
    for (const scalar of coreStrings) {
      const target = path.join(skills, `core-string-${scalar.replace(/[^A-Za-z0-9]/g, '-')}`);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'SKILL.md'),
        `---\nname: ${scalar}\ndescription: YAML 1.2 Core string\n---\n`);
    }

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.strictEqual(audit.errors.length, coreNonStrings.length, JSON.stringify(audit.errors));
    assert.ok(audit.errors.every(({ path: skillPath, code, message }) =>
      skillPath.startsWith('plain-')
      && code === 'unsupported-name-scalar'
      && /implicit non-string YAML scalars/.test(message)), JSON.stringify(audit.errors));
    const names = new Set(audit.skills.map(({ name }) => name));
    for (const scalar of coreNonStrings) assert.ok(names.has(scalar), `quoted string missing: ${scalar}`);
    for (const scalar of coreStrings) assert.ok(names.has(scalar), `Core string missing: ${scalar}`);
    assert.deepStrictEqual(audit.duplicates, []);
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor YAML falha fechado para anchors, tags, aliases, blocks e keys complexas', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const unsupported = new Map([
      ['anchor-name', 'name: &copy duplicate'],
      ['tag-name', 'name: !custom duplicate'],
      ['alias-name', 'name: *copy'],
      ['literal-block', 'name: |\n  duplicate'],
      ['folded-block', 'name: >\n  duplicate'],
      ['multiline-quote', 'name: "multi\n  line"'],
      ['multiline-plain', 'name: duplicate\n  continued'],
      ['quoted-key', '"name": duplicate'],
      ['complex-key', '? name\n: duplicate'],
      ['implicit-bool', 'name: true'],
      ['implicit-number', 'name: 123.5'],
      ['escaped-control', 'name: "bad\\nname"'],
      ['description-block-name', 'license: |\n  prose only\n  name: hidden-in-description'],
      ['nested-name', 'metadata:\n  name: hidden-in-map'],
      ['tab-name', '\tname: hidden-behind-tab'],
      ['duplicate-description', 'name: duplicate-description\nlicense: MIT\nlicense: Apache-2.0'],
      ['duplicate-nested-key', 'name: duplicate-nested-key\nmetadata:\n  owner: one\n  owner: two'],
      ['invalid-block-chomping', 'name: invalid-block-chomping\nlicense: |+-\n  text'],
      ['invalid-block-comment-separator', 'name: invalid-block-comment-separator\nlicense: |#comment\n  text'],
      ['invalid-block-explicit-indent', 'name: invalid-block-explicit-indent\nlicense: |2\n one-space'],
      ['invalid-block-dedent', 'name: invalid-block-dedent\nlicense: |\n  two-spaces\n one-space'],
      ['tab-block-body', 'name: tab-block-body\nlicense: |\n  valid\n\tinvalid'],
      ['lone-surrogate-escape', 'name: "bad\\uD800"'],
      ['plain-colon-separation', 'name: plain-colon-separation\nlicense: foo: bar'],
      ['plain-sequence-indicator', 'name: plain-sequence-indicator\nlicense: - item'],
      ['plain-directive-indicator', 'name: plain-directive-indicator\nlicense: %YAML'],
      ['plain-flow-end-indicator', 'name: plain-flow-end-indicator\nlicense: ]oops'],
      ['plain-comment-introducer', 'name: plain-comment-introducer\nlicense: MIT # comment'],
      ['compact-name-key', 'name:foo'],
      ['spaced-name-key', 'name :foo'],
      ['compact-description-key', 'name: compact-description-key\ndescription:value'],
    ]);
    for (const [directory, metadata] of unsupported) {
      const target = path.join(skills, directory);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'), `---\n${metadata}\ndescription: unsupported yaml\n---\n`);
    }
    const invalidUtf8 = path.join(skills, 'invalid-utf8');
    fs.mkdirSync(invalidUtf8, { recursive: true });
    fs.writeFileSync(
      path.join(invalidUtf8, 'SKILL.md'),
      Buffer.concat([
        Buffer.from('---\nname: invalid-utf8\ndescription: '),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('\n---\n'),
      ]),
    );

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.strictEqual(audit.errors.length, unsupported.size + 1, JSON.stringify(audit.errors));
    assert.deepStrictEqual(
      audit.errors.map(({ path }) => path),
      [...unsupported.keys(), 'invalid-utf8'].sort().map((directory) => path.join(directory, 'SKILL.md')),
    );
    assert.ok(audit.errors.every(({ code, message }) => typeof code === 'string' && code.length > 0
      && typeof message === 'string' && message.length > 0));
    assert.strictEqual(
      audit.errors.find(({ path: skillPath }) => skillPath === path.join('description-block-name', 'SKILL.md')).code,
      'missing-name-key',
    );
    for (const directory of ['nested-name', 'tab-name']) {
      assert.strictEqual(
        audit.errors.find(({ path: skillPath }) => skillPath === path.join(directory, 'SKILL.md')).code,
        'unsupported-yaml-structure',
      );
    }
    assert.ok(!audit.skills.some(({ name }) => name === 'duplicate'),
      'construções YAML ambíguas não podem virar nome literal nem esconder duplicate via parsing parcial');
    assert.ok(!audit.skills.some(({ name }) => name === 'foo' || name === 'value'),
      'mapping sem separação ASCII válida não pode virar skill');

    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(
      result.stdout,
      new RegExp(`FAIL\\s+invalid or unsupported Cursor skill metadata \\(${unsupported.size + 1} SKILL\\.md\\)`),
      result.stdout,
    );
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor expõe links externos; doctor autoriza só links exatos do manifesto', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const cursorRoot = path.join(home, 'cursor-home');
    const skills = path.join(cursorRoot, 'skills');

    const healthyAuditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(healthyAuditRun.status, 0, healthyAuditRun.stderr);
    const healthyAudit = JSON.parse(healthyAuditRun.stdout);
    assert.ok(healthyAudit.escapes.includes('dead-code-audit'), JSON.stringify(healthyAudit.escapes));
    assert.ok(healthyAudit.escapes.includes(path.join('dead-code-audit', 'SKILL.md')),
      JSON.stringify(healthyAudit.escapes));

    const healthyDoctor = runDoctor(home, { cursorHome: cursorRoot });
    assert.doesNotMatch(healthyDoctor.stdout, /FAIL\s+unmanaged symlink escapes under Cursor skills/,
      healthyDoctor.stdout);
    assert.match(healthyDoctor.stdout, /OK\s+Cursor harness wiring resolves/, healthyDoctor.stdout);

    const external = path.join(home, 'external-unique-skill');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'SKILL.md'), '---\nname: external-unique\ndescription: external\n---\n');
    const externalBefore = snapshotDoctorTree(external);
    const nestedEscape = path.join('impeccable', 'user-external');
    fs.symlinkSync(external, path.join(skills, nestedEscape));

    const escapedAuditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(escapedAuditRun.status, 0, escapedAuditRun.stderr);
    const escapedAudit = JSON.parse(escapedAuditRun.stdout);
    assert.ok(escapedAudit.escapes.includes(nestedEscape));
    assert.ok(escapedAudit.escapes.includes(path.join(nestedEscape, 'SKILL.md')));

    const failedDoctor = runDoctor(home, { cursorHome: cursorRoot });
    assert.match(failedDoctor.stdout, /FAIL\s+unmanaged symlink escapes under Cursor skills \(2\)/,
      failedDoctor.stdout);
    assert.strictEqual(failedDoctor.code, 1, failedDoctor.stdout);
    assert.deepStrictEqual(snapshotDoctorTree(external), externalBefore,
      'auditor/doctor read-only não pode alterar a árvore externa');
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor de manifesto aceita só raw target absoluto/relativo canônico exato', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(path.dirname(REPO_ROOT), 'cursor-audit-'));
  let inSourceParentAlias = null;
  try {
    const skills = path.join(fixtureRoot, 'skills');
    fs.mkdirSync(skills);
    const source = fs.realpathSync(path.join(REPO_ROOT, 'active', 'skills', 'dead-code-audit'));
    const target = path.join(skills, 'managed');
    const installed = path.join(fixtureRoot, 'installed.tsv');
    const desiredRaw = `managed\t${source}\tlink\tcortex\n`;
    fs.writeFileSync(installed, desiredRaw);
    const alias = path.join(fixtureRoot, 'source-alias');
    fs.symlinkSync(source, alias);
    const parent = path.dirname(source);
    const grandparent = path.dirname(parent);
    inSourceParentAlias = path.join(parent, `.cursor-audit-alias-${path.basename(fixtureRoot)}`);
    fs.symlinkSync(source, inSourceParentAlias);
    const invalidTargets = new Map([
      ['alias-component', alias],
      ['alias-plus-dotdot', `${inSourceParentAlias}/../${path.basename(source)}`],
      ['excessive-dotdot', `${parent}/../${path.basename(parent)}/${path.basename(source)}`],
      ['duplicate-slash', `${parent}//${path.basename(source)}`],
      ['dot-component', `${grandparent}/${path.basename(parent)}/./${path.basename(source)}`],
    ]);
    const audit = () => {
      const result = spawnSync(process.execPath, [
        CURSOR_AUDIT_TOOL,
        skills,
        '--manifests',
        installed,
        desiredRaw,
        fs.realpathSync(REPO_ROOT),
      ], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    for (const [label, rawTarget] of invalidTargets) {
      if (fs.lstatSync(target, { throwIfNoEntry: false })) fs.unlinkSync(target);
      fs.symlinkSync(rawTarget, target);
      const result = audit();
      assert.ok(result.unapprovedEscapes.includes('managed'), `${label}: ${JSON.stringify(result)}`);
      assert.ok(result.unapprovedEscapes.includes(path.join('managed', 'SKILL.md')),
        `${label}: ${JSON.stringify(result)}`);
      assert.deepStrictEqual(result.allowedEscapes, [], label);
    }

    fs.unlinkSync(target);
    fs.symlinkSync(source, target);
    const absolute = audit();
    assert.deepStrictEqual(absolute.unapprovedEscapes, []);
    assert.ok(absolute.allowedEscapes.includes('managed'));
    assert.deepStrictEqual(absolute.errors, []);

    fs.unlinkSync(target);
    const relativeTarget = path.relative(path.dirname(target), source);
    fs.symlinkSync(relativeTarget, target);
    const relative = audit();
    assert.deepStrictEqual(relative.unapprovedEscapes, []);
    assert.ok(relative.allowedEscapes.includes('managed'));
    assert.deepStrictEqual(relative.errors, []);
  } finally {
    if (inSourceParentAlias) fs.rmSync(inSourceParentAlias, { force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('[doctor] reconcilia frontmatter imediato de cada row link/cursor-copy/gstack-copy', () => {
  const home = mkTempHome();
  try {
    const repoRoot = path.join(home, 'cortex');
    const skills = path.join(home, 'cursor-skills');
    const linkSource = path.join(repoRoot, 'codex', 'skills-local', 'hm-init');
    fs.mkdirSync(linkSource, { recursive: true });
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(
      path.join(linkSource, 'SKILL.md'),
      '---\nname: hm-init-renamed\ndescription: mismatch\n---\n',
    );
    const repoCanonical = fs.realpathSync(repoRoot);
    const linkSourceCanonical = fs.realpathSync(linkSource);
    fs.symlinkSync(linkSourceCanonical, path.join(skills, 'hm-init'));
    for (const [name, declared] of [
      ['impeccable', 'impeccable-renamed'],
      ['gstack-review', 'gstack-review-renamed'],
    ]) {
      const target = path.join(skills, name);
      fs.mkdirSync(target);
      fs.writeFileSync(
        path.join(target, 'SKILL.md'),
        `---\nname: ${declared}\ndescription: mismatch\n---\n`,
      );
    }
    const rows = [
      `hm-init\t${linkSourceCanonical}\tlink\thm`,
      `impeccable\t${path.join(repoCanonical, 'active', 'skills', 'impeccable')}\tcursor-copy\tcortex`,
      `gstack-review\t${path.join(home, 'gstack', '.cursor', 'skills', 'gstack-review')}\tgstack-copy\tgstack`,
    ].join('\n') + '\n';
    const installed = path.join(home, 'installed.tsv');
    fs.writeFileSync(installed, rows);
    const auditRun = spawnSync(process.execPath, [
      CURSOR_AUDIT_TOOL,
      skills,
      '--manifests',
      installed,
      rows,
      repoCanonical,
    ], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.deepStrictEqual(
      audit.reconciliationErrors
        .filter((error) => error.code === 'installed-name-mismatch')
        .map((error) => error.message)
        .sort(),
      [
        'installed manifest target gstack-review declares frontmatter name gstack-review-renamed',
        'installed manifest target hm-init declares frontmatter name hm-init-renamed',
        'installed manifest target impeccable declares frontmatter name impeccable-renamed',
      ],
    );
    assert.deepStrictEqual(audit.duplicates, [], 'unique renamed identities must still fail reconciliation');
  } finally {
    rmHome(home);
  }
});

test('[doctor] auditor rejeita marker Jarvis forjado por nome/source/mode/provenance', () => {
  const home = mkTempHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review', 'gstack-browse']);
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    const skills = path.join(cursorRoot, 'skills');
    const manifestPath = path.join(cursorRoot, 'jarvis-cortex-skills.manifest.tsv');
    const desired = spawnSync(process.execPath, [CURSOR_MANIFEST_TOOL, REPO_ROOT, gstackRoot], {
      encoding: 'utf8',
    });
    assert.strictEqual(desired.status, 0, desired.stderr);
    const markerPath = path.join(skills, 'gstack-review', '.jarvis-cortex-skill.json');
    const original = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const browseSource = fs.realpathSync(path.join(gstackRoot, '.cursor', 'skills', 'gstack-browse'));
    const variants = [
      ['name', { name: 'gstack-browse' }],
      ['source', { sourcePath: browseSource, sourceReal: browseSource }],
      ['mode', { mode: 'cursor-copy' }],
      ['provenance', { provenance: 'cortex' }],
    ];
    for (const [label, change] of variants) {
      fs.writeFileSync(markerPath, `${JSON.stringify({ ...original, ...change }, null, 2)}\n`, { mode: 0o600 });
      const auditRun = spawnSync(process.execPath, [
        CURSOR_AUDIT_TOOL,
        skills,
        '--manifests',
        manifestPath,
        desired.stdout,
        REPO_ROOT,
      ], { encoding: 'utf8' });
      assert.strictEqual(auditRun.status, 0, auditRun.stderr);
      const audit = JSON.parse(auditRun.stdout);
      assert.ok(
        audit.reconciliationErrors.some((error) => error.code === 'managed-marker-mismatch'
          && error.name === 'gstack-review'),
        `${label}: ${JSON.stringify(audit.reconciliationErrors)}`,
      );
    }
  } finally {
    rmHome(home);
  }
});

test('[doctor] relative raw canônico usa parent físico sob ancestral lexical alias', () => {
  const home = mkTempHome();
  try {
    bootstrapCursor(home);
    const cursorRoot = path.join(home, 'cursor-home');
    const skills = path.join(cursorRoot, 'skills');
    const manifestPath = path.join(cursorRoot, 'jarvis-cortex-skills.manifest.tsv');
    const installedRaw = fs.readFileSync(manifestPath, 'utf8');
    const row = installedRaw.split('\n').find((line) => line.startsWith('dead-code-audit\t'));
    const [, source] = row.split('\t');
    const target = path.join(skills, 'dead-code-audit');
    const logicalParent = path.dirname(target);
    const physicalParent = fs.realpathSync(logicalParent);
    const exactRelative = path.relative(physicalParent, source);
    fs.unlinkSync(target);
    fs.symlinkSync(exactRelative, target);
    if (process.platform === 'darwin' && path.resolve(logicalParent).startsWith('/var/')) {
      assert.notStrictEqual(path.resolve(logicalParent), physicalParent,
        'macOS fixture must exercise /var -> /private/var ancestor alias');
    }

    // Bootstrap ownership, audit reconciliation and doctor must all use the
    // same physical-parent relative spelling and preserve it byte-for-byte.
    bootstrapCursor(home);
    assert.strictEqual(fs.readlinkSync(target), exactRelative);
    const generated = spawnSync(process.execPath, [
      CURSOR_MANIFEST_TOOL,
      REPO_ROOT,
      path.join(home, '.gstack', 'repos', 'gstack'),
    ], { encoding: 'utf8' });
    assert.strictEqual(generated.status, 0, generated.stderr);
    const auditRun = spawnSync(process.execPath, [
      CURSOR_AUDIT_TOOL,
      skills,
      '--manifests',
      manifestPath,
      generated.stdout,
      REPO_ROOT,
    ], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.deepStrictEqual(audit.reconciliationErrors, []);
    assert.deepStrictEqual(audit.unapprovedEscapes, []);
    assert.ok(audit.allowedEscapes.includes('dead-code-audit'));
    assert.ok(audit.allowedEscapes.includes(path.join('dead-code-audit', 'SKILL.md')));

    const doctor = runDoctor(home, { cursorHome: cursorRoot });
    assert.strictEqual(doctor.code, 0, doctor.stdout);
    assert.match(doctor.stdout, /OK\s+Cursor harness wiring resolves/);
  } finally {
    rmHome(home);
  }
});

test('[doctor] duplicate local contra link externo autorizado continua detectado', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const cursorRoot = path.join(home, 'cursor-home');
    const duplicate = path.join(cursorRoot, 'skills', 'nested', 'duplicate-managed-name');
    fs.mkdirSync(duplicate, { recursive: true });
    fs.writeFileSync(
      path.join(duplicate, 'SKILL.md'),
      '---\nname: dead-code-audit\ndescription: local duplicate\n---\n',
    );

    const result = runDoctor(home, { cursorHome: cursorRoot });
    assert.match(result.stdout, /FAIL\s+duplicate Cursor native skill names: dead-code-audit/,
      result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] raw targets não canônicos em link managed e runtime gstack falham proveniência', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    const manifest = fs.readFileSync(
      path.join(cursorRoot, 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    );
    const hmSource = manifest.split('\n').find((line) => line.startsWith('hm-init\t')).split('\t')[1];
    const hmAlias = path.join(home, 'hm-source-alias');
    const hmParentAlias = path.join(home, 'hm-parent-alias');
    const hmTarget = path.join(cursorRoot, 'skills', 'hm-init');
    fs.symlinkSync(hmSource, hmAlias);
    fs.symlinkSync(path.dirname(hmSource), hmParentAlias);

    const runtimeSource = path.join(cursorRoot, 'jarvis-runtime', 'gstack', 'source');
    const runtimeAlias = path.join(home, 'gstack-source-alias');
    const runtimeParentAlias = path.join(home, 'gstack-parent-alias');
    fs.symlinkSync(gstackRoot, runtimeAlias);
    fs.symlinkSync(path.dirname(gstackRoot), runtimeParentAlias);
    const hmParent = path.dirname(hmSource);
    const hmGrandparent = path.dirname(hmParent);
    const runtimeParent = path.dirname(gstackRoot);
    const rawTargets = [
      [hmAlias, runtimeAlias],
      [
        `${hmParentAlias}/../${path.basename(hmParent)}/${path.basename(hmSource)}`,
        `${runtimeParentAlias}/../${path.basename(runtimeParent)}/${path.basename(gstackRoot)}`,
      ],
      [
        `${hmParent}/../${path.basename(hmParent)}/${path.basename(hmSource)}`,
        `${gstackRoot}/../${path.basename(gstackRoot)}`,
      ],
      [`${hmParent}//${path.basename(hmSource)}`, `${runtimeParent}//${path.basename(gstackRoot)}`],
      [
        `${hmGrandparent}/${path.basename(hmParent)}/./${path.basename(hmSource)}`,
        `${runtimeParent}/./${path.basename(gstackRoot)}`,
      ],
    ];
    for (const [hmRaw, runtimeRaw] of rawTargets) {
      fs.unlinkSync(hmTarget);
      fs.unlinkSync(runtimeSource);
      fs.symlinkSync(hmRaw, hmTarget);
      fs.symlinkSync(runtimeRaw, runtimeSource);
      const result = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
      assert.match(result.stdout,
        /FAIL\s+(?:unmanaged symlink escapes under Cursor skills|Cursor native skill has unexpected provenance: hm-init)/,
        result.stdout);
      assert.match(result.stdout, /FAIL\s+Cursor gstack runtime wrapper is misplaced or has unexpected provenance/,
        result.stdout);
      assert.strictEqual(result.code, 1, result.stdout);
    }

    fs.unlinkSync(hmTarget);
    fs.unlinkSync(runtimeSource);
    fs.symlinkSync(hmSource, hmTarget);
    fs.symlinkSync(fs.realpathSync(gstackRoot), runtimeSource);
    const healthy = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(healthy.code, 0, healthy.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] invocação por ~/.codex/jarvis-cortex symlink usa checkout físico', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const codexHome = path.join(home, '.codex');
    const checkoutAlias = path.join(codexHome, 'jarvis-cortex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.symlinkSync(REPO_ROOT, checkoutAlias);
    const aliasedBootstrap = path.join(checkoutAlias, 'scripts', 'bootstrap-cursor.sh');
    bootstrapCursor(home, { script: aliasedBootstrap });

    const result = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      script: path.join(checkoutAlias, 'scripts', 'doctor.sh'),
    });
    assert.doesNotMatch(result.stdout, /FAIL\s+cortex root does not look like the cortex/, result.stdout);
    assert.doesNotMatch(result.stdout, /FAIL\s+Cursor installed skill manifest diverges from desired state/, result.stdout);
    assert.match(result.stdout, new RegExp(`OK\\s+cortex root resolves \\(${fs.realpathSync(REPO_ROOT)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), result.stdout);
    assert.match(result.stdout, /OK\s+Cursor harness wiring resolves/, result.stdout);
  } finally {
    rmHome(home);
  }
});

// Deterministic stand-in for an installed ~/.cursor/skills tree. Reproduces the
// input classes a live tree provides — every frontmatter shape the YAML subset
// must accept, a nested skill bundle, a non-SKILL.md asset, and top-level
// symlinks that escape the root — but with a known answer, so the assertion is
// exact and runs everywhere instead of only on a machine that happens to have
// Cursor installed.
function createCursorSkillsAuditFixture(home) {
  const skills = path.join(home, 'cursor-skills-fixture', 'skills');
  const external = path.join(home, 'external-skill-sources');
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(external, { recursive: true });

  const frontmatters = new Map([
    // Plain scalars — the overwhelmingly common shape.
    ['plain-skill', '---\nname: plain-skill\ndescription: A plain scalar description\n---\n\n# Plain\n'],
    // Single-quoted name, with the doubled-quote escape in the description.
    ['quoted-skill', "---\nname: 'single-quoted-skill'\ndescription: 'it''s quoted'\n---\n"],
    // Double-quoted name plus a Unicode/control escape in the description.
    ['double-quoted-skill', '---\nname: "double-quoted-skill"\ndescription: "caf\\u00e9\\tescaped"\n---\n'],
    // Literal and folded block scalars, the shape long descriptions use.
    ['block-literal-skill', '---\nname: block-literal-skill\ndescription: |\n  First line\n  Second line\n---\n'],
    ['block-folded-skill', '---\nname: block-folded-skill\ndescription: >-\n  Folded text that\n  continues here\n---\n'],
    // Nested mapping, including a deeper level and implicit non-string leaves.
    ['nested-mapping-skill', '---\nname: nested-mapping-skill\ndescription: nested metadata\nmetadata:\n  category: engineering\n  level: 3\n  nested:\n    deeper: true\n---\n'],
    // Sequence of plain scalars.
    ['sequence-skill', '---\nname: sequence-skill\ndescription: tag list\ntags:\n  - alpha\n  - beta-two\n---\n'],
    // Sequence of mappings (the allowed-tools shape).
    ['sequence-mapping-skill', '---\nname: sequence-mapping-skill\ndescription: list of mappings\nallowed-tools:\n  - tool: Read\n    scope: repo\n  - tool: Write\n    scope: repo\n---\n'],
    // Comments (leading, trailing, and after a quoted scalar) and a blank line.
    ['comment-skill', '---\n# managed by the cortex bootstrap\nname: comment-skill\n\ndescription: "keeps trailing comments"   # inline\n# trailing comment\n---\n'],
    // Dots and underscores are inside the supported plain-name subset, and the
    // directory name does not have to match the declared name.
    ['dotted-name-dir', '---\nname: hm-data_integrity.v2\ndescription: dotted name\n---\n'],
    // Non-ASCII description — the cortex's own skills are written in pt-BR.
    ['acento-skill', '---\nname: acento-skill\ndescription: Auditoria de código morto com acentuação\n---\n'],
    // CRLF line endings.
    ['crlf-skill', '---\r\nname: crlf-skill\r\ndescription: crlf line endings\r\n---\r\n'],
    // Nested bundle: skills discovered below the top level.
    [path.join('plugin-bundle', 'child-one'), '---\nname: bundle-child-one\ndescription: nested child\n---\n'],
    [path.join('plugin-bundle', 'child-two'), '---\nname: bundle-child-two\ndescription: nested child\n---\n'],
  ]);
  // The name a correct subset parser must extract from each frontmatter above.
  const expectedNames = new Map([
    ['plain-skill', 'plain-skill'],
    ['quoted-skill', 'single-quoted-skill'],
    ['double-quoted-skill', 'double-quoted-skill'],
    ['block-literal-skill', 'block-literal-skill'],
    ['block-folded-skill', 'block-folded-skill'],
    ['nested-mapping-skill', 'nested-mapping-skill'],
    ['sequence-skill', 'sequence-skill'],
    ['sequence-mapping-skill', 'sequence-mapping-skill'],
    ['comment-skill', 'comment-skill'],
    ['dotted-name-dir', 'hm-data_integrity.v2'],
    ['acento-skill', 'acento-skill'],
    ['crlf-skill', 'crlf-skill'],
    [path.join('plugin-bundle', 'child-one'), 'bundle-child-one'],
    [path.join('plugin-bundle', 'child-two'), 'bundle-child-two'],
  ]);
  assert.strictEqual(expectedNames.size, frontmatters.size,
    'every fixture frontmatter needs a declared expected name');
  for (const [directory, frontmatter] of frontmatters) {
    assert.ok(expectedNames.has(directory), `fixture row without expected name: ${directory}`);
    fs.mkdirSync(path.join(skills, directory), { recursive: true });
    fs.writeFileSync(path.join(skills, directory, 'SKILL.md'), frontmatter);
  }
  // Non-SKILL.md assets: the auditor must read them safely without parsing them.
  fs.mkdirSync(path.join(skills, 'plain-skill', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'plain-skill', 'reference.md'), '# reference\n');
  fs.writeFileSync(path.join(skills, 'plain-skill', 'assets', 'notes.txt'), 'asset\n');

  // Top-level symlinks that leave the root: they must be reported as escapes and
  // their frontmatter must NOT be parsed into skills without manifest approval.
  const expectedTopLevelEscapes = ['external-alpha', 'external-beta'];
  for (const name of expectedTopLevelEscapes) {
    fs.mkdirSync(path.join(external, name), { recursive: true });
    fs.writeFileSync(
      path.join(external, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: outside the skills root\n---\n`,
    );
    fs.symlinkSync(path.join(external, name), path.join(skills, name));
  }

  // Expected skills are derived from the same table that writes the tree, so the
  // expectation can never drift from the fixture. The name is still an
  // independent claim: it is what a correct subset parser must extract from the
  // raw YAML on the left, not a copy of anything the auditor produced.
  const expectedSkills = [...frontmatters.keys()]
    .map((directory) => ({ name: expectedNames.get(directory), path: path.join(directory, 'SKILL.md') }))
    .sort((left, right) => left.path.localeCompare(right.path));
  // Escapes are asserted COMPLETE, recursive entries included: a top-level
  // directory symlink that leaves the root reports both the directory and the
  // SKILL.md reached through it. Without manifest approval every escape must be
  // unapproved and none may be allowed, which is also why the external names
  // must be absent from expectedSkills.
  const expectedEscapes = expectedTopLevelEscapes
    .flatMap((name) => [name, path.join(name, 'SKILL.md')])
    .sort();
  return { skills, expectedSkills, expectedEscapes };
}

test('[doctor] subset YAML cobre a árvore Cursor sem metadata unsupported', () => {
  const home = mkTempHome();
  try {
    const { skills, expectedSkills, expectedEscapes } = createCursorSkillsAuditFixture(home);
    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], {
      encoding: 'utf8',
    });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    // Every field the auditor emits is pinned. Nothing is filtered down to a
    // convenient subset and nothing is asserted via a total that the earlier
    // assertions already imply — a regression in any single classification
    // (recursive escapes included) has to surface here.
    assert.deepStrictEqual(audit.skills
      .map(({ name, path: relative }) => ({ name, path: relative }))
      .sort((left, right) => left.path.localeCompare(right.path)), expectedSkills);
    assert.deepStrictEqual(audit.escapes, expectedEscapes);
    assert.deepStrictEqual(audit.unapprovedEscapes, expectedEscapes);
    assert.deepStrictEqual(audit.allowedEscapes, []);
    assert.deepStrictEqual(audit.errors, []);
    assert.deepStrictEqual(audit.duplicates, []);
    assert.deepStrictEqual(audit.cycles, []);
    assert.deepStrictEqual(audit.dangling, []);
    assert.deepStrictEqual(audit.backups, []);
    assert.deepStrictEqual(audit.reconciliationErrors, []);
    assert.deepStrictEqual(
      Object.keys(audit).sort(),
      ['allowedEscapes', 'backups', 'cycles', 'dangling', 'duplicates', 'errors',
        'escapes', 'reconciliationErrors', 'skills', 'unapprovedEscapes'],
      'auditor grew a field this test does not pin',
    );
  } finally {
    rmHome(home);
  }
});

// This one deliberately audits the REAL gstack checkout: its value is exactly
// that the frontmatter is third-party, so a fixture cannot stand in for it (the
// fixture case above already covers the parser against inputs we author). The
// expectation is derived from the tree instead of a hardcoded count, so a
// gstack release that adds or drops skills cannot make it fail spuriously —
// only a skill the subset parser fails to read can.
test('[doctor] subset YAML cobre o checkout gstack real sem metadata unsupported', {
  skip: !HAVE_REAL_GSTACK && REAL_GSTACK_SKIP,
}, () => {
  const assertGstackIntact = realGstackGuard();
  const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, REAL_GSTACK_CURSOR_SKILLS], {
    encoding: 'utf8',
  });
  assert.strictEqual(auditRun.status, 0, auditRun.stderr);
  const audit = JSON.parse(auditRun.stdout);
  assert.deepStrictEqual(audit.errors, []);
  // Precondition that makes the derivation below sound: with no escapes, every
  // SKILL.md the auditor can reach resolves inside the tree, so "directory whose
  // SKILL.md stats as a file" is exactly the set the auditor must parse. statSync
  // (not lstatSync) because the auditor follows SKILL.md symlinks that stay in
  // root; a dangling one stats as absent for both.
  assert.deepStrictEqual(audit.escapes, []);
  const expectedTopLevel = fs.readdirSync(REAL_GSTACK_CURSOR_SKILLS).sort()
    .filter((entry) => {
      const directory = path.join(REAL_GSTACK_CURSOR_SKILLS, entry);
      if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return false;
      return Boolean(fs.statSync(path.join(directory, 'SKILL.md'), {
        throwIfNoEntry: false,
      })?.isFile());
    });
  // Not vacuous on an empty or skill-less tree: an empty derivation fails here
  // rather than trivially matching an empty audit.skills.
  assert.ok(expectedTopLevel.length > 0, 'checkout gstack real não tem skills top-level');
  assert.deepStrictEqual(
    audit.skills.map(({ path: relative }) => relative.split(path.sep))
      .filter((segments) => segments.length === 2 && segments[1] === 'SKILL.md')
      .map(([directory]) => directory)
      .sort(),
    expectedTopLevel,
  );
  assertGstackIntact();
});

test('[doctor] auditor lstat classifica SKILL.md dangling, ciclo, escape e backup sem seguir externo', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    const external = path.join(home, 'external-skill-files');
    const backup = path.join(external, '.backups');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(external, 'SKILL.md'), '---\nname: escaped-name\ndescription: external\n---\n');
    fs.writeFileSync(path.join(backup, 'SKILL.md'), '---\nname: backup-name\ndescription: backup\n---\n');

    for (const directory of ['dangling-file', 'cycle-file-a', 'cycle-file-b', 'escape-file', 'backup-file']) {
      fs.mkdirSync(path.join(skills, directory));
    }
    fs.symlinkSync(path.join(home, 'missing-skill.md'), path.join(skills, 'dangling-file', 'SKILL.md'));
    fs.symlinkSync(path.join(skills, 'cycle-file-b', 'SKILL.md'), path.join(skills, 'cycle-file-a', 'SKILL.md'));
    fs.symlinkSync(path.join(skills, 'cycle-file-a', 'SKILL.md'), path.join(skills, 'cycle-file-b', 'SKILL.md'));
    fs.symlinkSync(path.join(external, 'SKILL.md'), path.join(skills, 'escape-file', 'SKILL.md'));
    fs.symlinkSync(path.join(backup, 'SKILL.md'), path.join(skills, 'backup-file', 'SKILL.md'));

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.deepStrictEqual(audit.dangling, [path.join('dangling-file', 'SKILL.md')]);
    assert.deepStrictEqual(audit.cycles, [
      path.join('cycle-file-a', 'SKILL.md'),
      path.join('cycle-file-b', 'SKILL.md'),
    ]);
    assert.deepStrictEqual(
      audit.escapes.filter((entry) => entry.startsWith('backup-file') || entry.startsWith('escape-file')),
      [path.join('backup-file', 'SKILL.md'), path.join('escape-file', 'SKILL.md')],
    );
    assert.deepStrictEqual(audit.backups, [path.join('backup-file', 'SKILL.md')]);
    assert.ok(!audit.skills.some(({ name }) => ['escaped-name', 'backup-name'].includes(name)),
      'auditor não pode ler frontmatter fora da raiz via SKILL.md symlink');

    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(result.stdout, /FAIL\s+backup skill trees under Cursor skills \(1 SKILL\.md\)/, result.stdout);
    assert.match(result.stdout, /FAIL\s+symlink cycles under Cursor skills \(2\)/, result.stdout);
    assert.match(result.stdout, /FAIL\s+dangling symlinks under Cursor skills \(1\)/, result.stdout);
    assert.match(result.stdout, /FAIL\s+unmanaged symlink escapes under Cursor skills/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] skill obrigatória ausente ou com proveniência errada → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    fs.unlinkSync(path.join(skills, 'orchestrate'));
    const custom = path.join(home, 'custom-security-audit');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: security-audit\ndescription: custom\n---\n');
    fs.unlinkSync(path.join(skills, 'security-audit'));
    fs.symlinkSync(custom, path.join(skills, 'security-audit'));

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+Cursor native skill missing, dangling, or not managed: orchestrate/, r.stdout);
    assert.match(r.stdout, /FAIL\s+Cursor native skill has unexpected provenance: security-audit/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] Impeccable Cursor-rendered adulterado → FAIL de proveniência', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skill = path.join(home, 'cursor-home', 'skills', 'impeccable', 'SKILL.md');
    fs.appendFileSync(skill, '\nchanged\n');
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+Cursor native skill has unexpected provenance: impeccable/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] database-backup legítimo e ancestral backup exato não são falsos positivos', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const ch = path.join(home, 'backup', 'cursor-home');
    bootstrapCursor(home, { cursorHome: ch });
    const legitimate = path.join(ch, 'skills', 'database-backup');
    fs.mkdirSync(legitimate, { recursive: true });
    fs.writeFileSync(path.join(legitimate, 'SKILL.md'), '---\nname: database-backup\ndescription: legitimate\n---\n');
    const r = runDoctor(home, { cursorHome: ch });
    assert.doesNotMatch(r.stdout, /FAIL\s+backup skill trees under Cursor skills/, r.stdout);
    assert.strictEqual(r.code, 0, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] diretório *.backup.* com SKILL.md → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const backup = path.join(home, 'cursor-home', 'skills', 'old.backup.20260721');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'SKILL.md'), '---\nname: old-copy\ndescription: backup\n---\n');
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+backup skill trees under Cursor skills/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] ciclo de symlink sob skills termina e falha explicitamente', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const cycle = path.join(home, 'cursor-home', 'skills', 'cycle');
    fs.mkdirSync(cycle, { recursive: true });
    fs.symlinkSync(cycle, path.join(cycle, 'again'));
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+symlink cycles under Cursor skills/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] ciclo puro A→B/B→A é detectado como ELOOP e falha', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const skills = path.join(home, 'cursor-home', 'skills');
    fs.symlinkSync(path.join(skills, 'cycle-b'), path.join(skills, 'cycle-a'));
    fs.symlinkSync(path.join(skills, 'cycle-a'), path.join(skills, 'cycle-b'));
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+symlink cycles under Cursor skills \(2\)/, r.stdout);
    assert.doesNotMatch(r.stdout, /FAIL\s+dangling symlinks under Cursor skills/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] third-party imports ligadas ou sem prova → FAIL acionável', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home, { thirdParty: 'true' });
    const r = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      thirdParty: 'true',
    });
    assert.match(r.stdout, /FAIL\s+Cursor third-party imports are not proven disabled \(on\)/, r.stdout);
    assert.match(r.stdout, /Include Third-Party Plugins, Skills, and Other Configs/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] lê a chave exata do state.vscdb e aceita somente false', {
  skip: !SQLITE_AVAILABLE,
}, () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const stateDb = path.join(home, 'cursor-state', 'state.vscdb');
    fs.mkdirSync(path.dirname(stateDb), { recursive: true });
    const setupDb = spawnSync('sqlite3', [stateDb, [
      'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
      "INSERT INTO ItemTable(key,value) VALUES('cursor/thirdPartyExtensibilityEnabled','false');",
    ].join(' ')], { encoding: 'utf8' });
    assert.strictEqual(setupDb.status, 0, setupDb.stderr);

    bootstrapCursor(home, { thirdParty: 'db', cursorStateDb: stateDb });
    const healthy = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      thirdParty: 'db',
      cursorStateDb: stateDb,
    });
    assert.match(healthy.stdout, /OK\s+Cursor third-party imports are explicitly disabled/, healthy.stdout);
    assert.strictEqual(healthy.code, 0, healthy.stdout);

    const unset = spawnSync('sqlite3', [stateDb,
      "DELETE FROM ItemTable WHERE key='cursor/thirdPartyExtensibilityEnabled';"],
    { encoding: 'utf8' });
    assert.strictEqual(unset.status, 0, unset.stderr);
    const unsafe = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      thirdParty: 'db',
      cursorStateDb: stateDb,
    });
    assert.match(unsafe.stdout, /FAIL\s+Cursor third-party imports are not proven disabled \(unset\)/, unsafe.stdout);
    assert.strictEqual(unsafe.code, 1, unsafe.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] CURSOR_USER_DATA_DIR aponta para a raiz do user-data-dir', {
  skip: !SQLITE_AVAILABLE,
}, () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const userDataDir = path.join(home, 'portable-cursor-data');
    const stateDb = path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
    fs.mkdirSync(path.dirname(stateDb), { recursive: true });
    const setupDb = spawnSync('sqlite3', [stateDb, [
      'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);',
      "INSERT INTO ItemTable(key,value) VALUES('cursor/thirdPartyExtensibilityEnabled','false');",
    ].join(' ')], { encoding: 'utf8' });
    assert.strictEqual(setupDb.status, 0, setupDb.stderr);

    bootstrapCursor(home, { thirdParty: 'db', cursorUserDataDir: userDataDir });
    const r = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      thirdParty: 'db',
      cursorUserDataDir: userDataDir,
    });
    assert.match(r.stdout, /OK\s+Cursor third-party imports are explicitly disabled/, r.stdout);
    assert.strictEqual(r.code, 0, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] gstack disponível entra no mesmo manifesto com proveniência exata', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
    assert.match(r.stdout, /Cursor native skill manifest resolves with exact provenance \(30 skills\)/, r.stdout);
    assert.match(r.stdout, /Cursor gstack runtime wrapper resolves outside the skills tree/, r.stdout);
    assert.strictEqual(r.code, 0, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] link source symlink externo falha proveniência sem mutar fonte externa', () => {
  const home = mkTempHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    const outside = path.join(home, 'outside-source');
    const cursorRoot = path.join(home, 'cursor-home');
    fs.mkdirSync(outside);
    copyCortexFixture(repoRoot);
    bootstrap(home, { script: path.join(repoRoot, 'scripts', 'bootstrap-claude.sh') });
    bootstrapCursor(home, {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh'),
    });
    const healthy = runDoctor(home, {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'doctor.sh'),
    });
    assert.strictEqual(healthy.code, 0, healthy.stdout);

    for (const variant of ['source-directory', 'intermediate-directory', 'skill-file']) {
      const corrupted = corruptDoctorLinkSource(repoRoot, outside, variant);
      try {
        const externalBefore = snapshotDoctorTree(corrupted.external);
        const result = runDoctor(home, {
          cursorHome: cursorRoot,
          script: path.join(repoRoot, 'scripts', 'doctor.sh'),
        });
        assert.strictEqual(result.code, 1, `${variant}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /FAIL\s+Cursor managed roots or fixed destinations are unsafe/);
        assert.doesNotMatch(result.stdout, /OK\s+Cursor native skill manifest resolves with exact provenance/);
        assert.deepStrictEqual(
          snapshotDoctorTree(corrupted.external),
          externalBefore,
          `${variant}: doctor changed the external source`,
        );
      } finally {
        corrupted.restore();
      }
    }
  } finally {
    rmHome(home);
  }
});

test('[doctor] frontmatter hm-init renomeado faz manifest/doctor falharem fechado', () => {
  const home = mkTempHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    const cursorRoot = path.join(home, 'cursor-home');
    copyCortexFixture(repoRoot);
    bootstrap(home, { script: path.join(repoRoot, 'scripts', 'bootstrap-claude.sh') });
    bootstrapCursor(home, {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh'),
    });
    const skillFile = path.join(repoRoot, 'codex', 'skills-local', 'hm-init', 'SKILL.md');
    fs.writeFileSync(
      skillFile,
      fs.readFileSync(skillFile, 'utf8').replace(/^name: hm-init$/m, 'name: hm-init-renamed'),
    );

    const result = runDoctor(home, {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'doctor.sh'),
    });
    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /FAIL\s+Cursor native skill manifest generation failed \(exit 1\)/);
  } finally {
    rmHome(home);
  }
});

test('[doctor] frontmatter instalado divergente falha para cursor-copy e gstack-copy únicos', () => {
  const home = mkTempHome();
  try {
    const gstackRoot = path.join(home, '.gstack', 'repos', 'gstack');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    for (const [name, renamed] of [
      ['impeccable', 'impeccable-renamed'],
      ['gstack-review', 'gstack-review-renamed'],
    ]) {
      const skillFile = path.join(cursorRoot, 'skills', name, 'SKILL.md');
      fs.writeFileSync(
        skillFile,
        fs.readFileSync(skillFile, 'utf8').replace(
          new RegExp(`^name: ${name}$`, 'm'),
          `name: ${renamed}`,
        ),
      );
    }

    const result = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /FAIL\s+Cursor native skill has unexpected provenance: impeccable/);
    assert.match(result.stdout, /FAIL\s+Cursor native gstack skill has unexpected provenance: gstack-review/);
    assert.match(result.stdout, /FAIL\s+Cursor skill manifest reconciliation could not trust installed targets \(2 errors\)/);
    assert.doesNotMatch(result.stdout, /duplicate Cursor native skill names/,
      'unique renamed identities must fail without relying on duplicate detection');
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor-copy detecta tipos e drift de modo na árvore instalada', () => {
  const home = mkTempHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const source = path.join(repoRoot, 'active', 'skills', 'impeccable');
    fs.mkdirSync(path.join(source, 'empty-assets'), { mode: 0o755 });
    fs.writeFileSync(path.join(source, 'asset.txt'), 'asset\n', { mode: 0o644 });
    fs.writeFileSync(path.join(source, 'tool.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(path.join(source, 'tool.sh'), 0o755);
    const cursorRoot = path.join(home, 'cursor-home');
    bootstrap(home, { script: path.join(repoRoot, 'scripts', 'bootstrap-claude.sh') });
    bootstrapCursor(home, {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh'),
    });
    const doctorOptions = {
      cursorHome: cursorRoot,
      script: path.join(repoRoot, 'scripts', 'doctor.sh'),
    };
    const healthy = runDoctor(home, doctorOptions);
    assert.strictEqual(healthy.code, 0, healthy.stdout);

    const target = path.join(cursorRoot, 'skills', 'impeccable');
    const fifoPath = path.join(target, 'tampered-fifo');
    const external = path.join(home, 'external-asset');
    fs.writeFileSync(external, 'external\n');
    const mutations = [
      [
        'empty directory',
        () => fs.mkdirSync(path.join(target, 'tampered-empty')),
        () => fs.rmdirSync(path.join(target, 'tampered-empty')),
      ],
      [
        'FIFO',
        () => {
          const made = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
          assert.strictEqual(made.status, 0, made.stderr);
        },
        () => fs.unlinkSync(fifoPath),
      ],
      [
        'symlink',
        () => fs.symlinkSync(external, path.join(target, 'tampered-link')),
        () => fs.unlinkSync(path.join(target, 'tampered-link')),
      ],
      [
        'regular file mode',
        () => fs.chmodSync(path.join(target, 'asset.txt'), 0o600),
        () => fs.chmodSync(path.join(target, 'asset.txt'), 0o644),
      ],
      [
        'directory mode',
        () => fs.chmodSync(path.join(target, 'empty-assets'), 0o700),
        () => fs.chmodSync(path.join(target, 'empty-assets'), 0o755),
      ],
      [
        'executable mode',
        () => fs.chmodSync(path.join(target, 'tool.sh'), 0o700),
        () => fs.chmodSync(path.join(target, 'tool.sh'), 0o755),
      ],
    ];
    for (const [label, apply, restore] of mutations) {
      apply();
      const failed = runDoctor(home, doctorOptions);
      assert.strictEqual(failed.code, 1, `${label}\n${failed.stdout}\n${failed.stderr}`);
      assert.match(failed.stdout,
        /FAIL\s+Cursor native skill has unexpected provenance: impeccable/, label);
      restore();
    }
    const recovered = runDoctor(home, doctorOptions);
    assert.strictEqual(recovered.code, 0, `restored tree\n${recovered.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] hardlinks em SKILL, asset ou marker falham para cursor-copy e gstack-copy', () => {
  const home = mkTempHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, [
      { name: 'review', sourceLeaf: 'gstack-review' },
    ]);
    fs.writeFileSync(
      path.join(gstackRoot, '.cursor', 'skills', 'gstack-review', 'asset.txt'),
      'asset\n',
      { mode: 0o644 },
    );
    const cursorRoot = path.join(home, 'cursor-home');
    bootstrap(home, { script: path.join(repoRoot, 'scripts', 'bootstrap-claude.sh') });
    bootstrapCursor(home, {
      cursorHome: cursorRoot,
      gstackRoot,
      script: path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh'),
    });
    const doctorOptions = {
      cursorHome: cursorRoot,
      gstackRoot,
      script: path.join(repoRoot, 'scripts', 'doctor.sh'),
    };
    const healthy = runDoctor(home, doctorOptions);
    assert.strictEqual(healthy.code, 0, healthy.stdout);

    const setups = [
      {
        name: 'impeccable',
        target: path.join(cursorRoot, 'skills', 'impeccable'),
        files: ['SKILL.md', 'reference/adapt.md', '.jarvis-cortex-skill.json'],
        failure: /FAIL\s+Cursor native skill has unexpected provenance: impeccable/,
      },
      {
        name: 'review',
        target: path.join(cursorRoot, 'skills', 'review'),
        files: ['SKILL.md', 'asset.txt', '.jarvis-cortex-skill.json'],
        failure: /FAIL\s+Cursor native gstack skill has unexpected provenance: review/,
      },
    ];
    for (const setup of setups) {
      for (const relative of setup.files) {
        const candidate = path.join(setup.target, relative);
        const original = fs.readFileSync(candidate);
        const mode = fs.lstatSync(candidate).mode & 0o777;
        const external = path.join(home, `doctor-${setup.name}-${relative.replaceAll('/', '-')}`);
        fs.writeFileSync(external, original, { mode });
        fs.chmodSync(external, mode);
        fs.unlinkSync(candidate);
        fs.linkSync(external, candidate);

        const failed = runDoctor(home, doctorOptions);
        assert.strictEqual(failed.code, 1, `${setup.name}:${relative}\n${failed.stdout}`);
        if (relative === '.jarvis-cortex-skill.json') {
          assert.match(failed.stdout,
            /FAIL\s+Cursor managed roots or fixed destinations are unsafe/,
            `${setup.name}:${relative}`);
        } else {
          assert.match(failed.stdout, setup.failure, `${setup.name}:${relative}`);
        }
        assert.doesNotMatch(failed.stdout,
          /OK\s+Cursor native skill manifest resolves with exact provenance/,
          `${setup.name}:${relative}`);

        fs.unlinkSync(candidate);
        fs.writeFileSync(candidate, original, { mode });
        fs.chmodSync(candidate, mode);
      }
    }
    const recovered = runDoctor(home, doctorOptions);
    assert.strictEqual(recovered.code, 0, recovered.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] gerador de manifesto falha atomicamente e doctor propaga o exit', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const gstackRoot = path.join(home, 'gstack-source');
    const invalidLeaf = path.join(gstackRoot, '.cursor', 'skills', 'gstack-invalid name');
    fs.mkdirSync(invalidLeaf, { recursive: true });
    fs.writeFileSync(
      path.join(invalidLeaf, 'SKILL.md'),
      '---\nname: invalid name\ndescription: invalid manifest leaf\n---\n',
    );

    const generated = spawnSync(process.execPath, [
      CURSOR_MANIFEST_TOOL, REPO_ROOT, gstackRoot,
    ], { encoding: 'utf8' });
    assert.strictEqual(generated.status, 1, generated.stderr);
    assert.strictEqual(generated.stdout, '', 'manifesto inválido não pode vazar stdout parcial');
    assert.match(
      generated.stderr,
      /invalid gstack Cursor catalog frontmatter gstack-invalid name: unsupported-name-scalar/,
    );

    const result = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      gstackRoot,
    });
    assert.match(
      result.stdout,
      /FAIL\s+Cursor native skill manifest generation failed \(exit 1\)/,
      result.stdout,
    );
    assert.doesNotMatch(
      result.stdout,
      /OK\s+Cursor native skill manifest resolves with exact provenance/,
      result.stdout,
    );
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] heredoc gstack inválido falha fechado já na geração do manifesto', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-invalid-heredoc']);
    bootstrapCursor(home, { gstackRoot });
    const source = path.join(gstackRoot, '.cursor', 'skills', 'gstack-invalid-heredoc', 'SKILL.md');
    fs.writeFileSync(source, [
      '---\nname: gstack-invalid-heredoc\ndescription: invalid\n---\n```bash\n',
      'cat <<MIXED\r\n$GSTACK_BIN/gstack-config protected\r\nMIXED\n',
      '$GSTACK_BIN/gstack-config must-not-be-digested-as-prose\n```\n',
    ].join(''));

    const generated = spawnSync(process.execPath, [CURSOR_MANIFEST_TOOL, REPO_ROOT, gstackRoot], {
      encoding: 'utf8',
    });
    assert.notStrictEqual(generated.status, 0, generated.stderr);
    assert.strictEqual(generated.stdout, '', 'manifesto parcial não pode ser emitido');
    assert.match(generated.stderr, /invalid generated Cursor skill|unterminated heredoc delimiter/);

    const result = runDoctor(home, {
      cursorHome: path.join(home, 'cursor-home'),
      gstackRoot,
    });
    assert.match(result.stdout, /FAIL\s+Cursor native skill manifest generation failed \(exit 1\)/, result.stdout);
    assert.doesNotMatch(result.stdout, /OK\s+Cursor native skill manifest resolves with exact provenance/, result.stdout);
    assert.strictEqual(result.code, 1, result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] install gstack → source removido → FAIL por manifesto/source/runtime stale', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    fs.rmSync(gstackRoot, { recursive: true, force: true });

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
    assert.match(
      r.stdout,
      /FAIL\s+Cursor installed skill manifest diverges from desired state: STALE gstack-review/,
      r.stdout,
    );
    assert.match(r.stdout, /FAIL\s+Cursor managed skill source missing: gstack-review/, r.stdout);
    assert.match(
      r.stdout,
      /FAIL\s+Cursor stale gstack manifest\/runtime exists without desired gstack skills/,
      r.stdout,
    );
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] orphan gstack real review/learn/browse retém tuple física e recupera source idêntica', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    const mappings = [
      { name: 'review', sourceLeaf: 'gstack-review' },
      { name: 'learn', sourceLeaf: 'gstack-learn' },
      { name: 'browse', sourceLeaf: 'gstack-browse' },
    ];
    createDoctorGstackFixture(gstackRoot, mappings);
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    const skills = path.join(cursorRoot, 'skills');
    const manifestPath = path.join(cursorRoot, 'jarvis-cortex-skills.manifest.tsv');
    for (const { name, sourceLeaf } of mappings) {
      const source = path.join(gstackRoot, '.cursor', 'skills', sourceLeaf);
      const saved = path.join(home, `saved-${sourceLeaf}`);
      const target = path.join(skills, name);
      const before = snapshotDoctorTree(target);
      fs.renameSync(source, saved);

      bootstrapCursor(home, { gstackRoot });
      assert.deepStrictEqual(snapshotDoctorTree(target), before,
        `${name} target must survive its differently named missing source leaf`);
      assert.match(fs.readFileSync(manifestPath, 'utf8'),
        new RegExp(`^${name}\\t.*\\/${sourceLeaf}\\tgstack-copy\\tgstack$`, 'm'),
        `${name} must retain the exact historical ${sourceLeaf} tuple`);
      const failed = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
      assert.match(failed.stdout,
        new RegExp(`FAIL\\s+orphaned or mismatched Jarvis markers under Cursor skills: ${name}`),
        failed.stdout);
      assert.strictEqual(failed.code, 1, failed.stdout);

      fs.renameSync(saved, source);
      const restoredBootstrap = bootstrapCursor(home, { gstackRoot });
      assert.doesNotMatch(restoredBootstrap.stderr,
        new RegExp(`${name}.*preserving it`), restoredBootstrap.stderr);
      assert.deepStrictEqual(snapshotDoctorTree(target), before,
        `${name} must recover without changing an already exact target`);
      const recovered = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
      assert.strictEqual(recovered.code, 0, recovered.stdout);
      assert.match(recovered.stdout, /doctor: \d+ ok, \d+ warn, 0 fail/);
    }

    const partialSource = path.join(gstackRoot, '.cursor', 'skills', 'gstack-review');
    const partialSkill = path.join(partialSource, 'SKILL.md');
    const savedSkill = path.join(home, 'saved-review-SKILL.md');
    const manifestBefore = fs.readFileSync(manifestPath);
    const reviewBefore = snapshotDoctorTree(path.join(skills, 'review'));
    fs.renameSync(partialSkill, savedSkill);
    const partial = bootstrapCursor(home, { gstackRoot, allowFailure: true });
    assert.notStrictEqual(partial.status, 0, partial.stderr);
    assert.match(partial.stderr, /invalid gstack Cursor catalog frontmatter|SKILL\.md/);
    assert.deepStrictEqual(fs.readFileSync(manifestPath), manifestBefore,
      'partial source must fail before replacing the installed manifest');
    assert.deepStrictEqual(snapshotDoctorTree(path.join(skills, 'review')), reviewBefore);
    const partialDoctor = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(partialDoctor.code, 1, partialDoctor.stdout);
    assert.match(partialDoctor.stdout, /FAIL\s+Cursor native skill manifest generation failed/);
    fs.renameSync(savedSkill, partialSkill);
    bootstrapCursor(home, { gstackRoot });
    assert.strictEqual(runDoctor(home, { cursorHome: cursorRoot, gstackRoot }).code, 0);

    const unreadableManifest = fs.readFileSync(manifestPath);
    const unreadableTarget = snapshotDoctorTree(path.join(skills, 'review'));
    fs.chmodSync(partialSkill, 0o000);
    const unreadable = bootstrapCursor(home, { gstackRoot, allowFailure: true });
    assert.notStrictEqual(unreadable.status, 0, unreadable.stderr);
    assert.deepStrictEqual(fs.readFileSync(manifestPath), unreadableManifest,
      'owner-unreadable source must fail before replacing the installed manifest');
    assert.deepStrictEqual(snapshotDoctorTree(path.join(skills, 'review')), unreadableTarget);
    assert.strictEqual(runDoctor(home, { cursorHome: cursorRoot, gstackRoot }).code, 1,
      'doctor must fail while the registered source is owner-unreadable');
    fs.chmodSync(partialSkill, 0o644);
    bootstrapCursor(home, { gstackRoot });
    assert.strictEqual(runDoctor(home, { cursorHome: cursorRoot, gstackRoot }).code, 0);
  } finally {
    rmHome(home);
  }
});

test('[doctor] árvore gstack adulterada durante orphan não fica verde após restaurar source', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, [
      { name: 'review', sourceLeaf: 'gstack-review' },
      { name: 'browse', sourceLeaf: 'gstack-browse' },
    ]);
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    const source = path.join(gstackRoot, '.cursor', 'skills', 'gstack-review');
    const saved = path.join(home, 'saved-gstack-review');
    const target = path.join(cursorRoot, 'skills', 'review');
    const manifestPath = path.join(cursorRoot, 'jarvis-cortex-skills.manifest.tsv');
    fs.renameSync(source, saved);
    fs.mkdirSync(path.join(target, 'tampered-empty-directory'));

    bootstrapCursor(home, { gstackRoot });
    assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^review\t/m,
      'digest mismatch must not retain orphan recovery authority');
    const missing = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(missing.code, 1, missing.stdout);
    assert.match(missing.stdout,
      /FAIL\s+orphaned or mismatched Jarvis markers under Cursor skills: review/,
      missing.stdout);

    fs.renameSync(saved, source);
    const restored = bootstrapCursor(home, { gstackRoot });
    assert.match(restored.stderr,
      /review.*not backed by the exact installed gstack-copy tuple|review.*preserving it/,
      restored.stderr);
    assert.ok(fs.lstatSync(path.join(target, 'tampered-empty-directory')).isDirectory(),
      'restored source must not authorize overwriting a target that lost recovery authority');
    assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^review\t/m);
    const stillFailed = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(stillFailed.code, 1, stillFailed.stdout);
    assert.match(stillFailed.stdout,
      /FAIL\s+orphaned or mismatched Jarvis markers under Cursor skills: review/,
      stillFailed.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] colisão binária legacy gstack continua FAIL após source restaurada', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, [
      { name: 'review', sourceLeaf: 'gstack-review' },
    ]);
    const source = path.join(gstackRoot, '.cursor', 'skills', 'gstack-review');
    fs.writeFileSync(path.join(source, 'a'), Buffer.concat([
      Buffer.from('X'), Buffer.from([0]), Buffer.from('F'), Buffer.from([0]),
      Buffer.from('b'), Buffer.from([0]), Buffer.from('420'), Buffer.from([0]), Buffer.from('Y'),
    ]), { mode: 0o644 });
    bootstrapCursor(home, { gstackRoot });
    const cursorRoot = path.join(home, 'cursor-home');
    const target = path.join(cursorRoot, 'skills', 'review');
    fs.writeFileSync(path.join(target, 'a'), 'X', { mode: 0o644 });
    fs.writeFileSync(path.join(target, 'b'), 'Y', { mode: 0o644 });

    const saved = path.join(home, 'saved-gstack-review');
    fs.renameSync(source, saved);
    fs.renameSync(saved, source);
    const result = runDoctor(home, { cursorHome: cursorRoot, gstackRoot });
    assert.strictEqual(result.code, 1, result.stdout);
    assert.match(result.stdout,
      /FAIL\s+Cursor native gstack skill has unexpected provenance: review/,
      result.stdout);
    assert.doesNotMatch(result.stdout,
      /OK\s+Cursor native skill manifest resolves with exact provenance/,
      result.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] gstack valida bin referenciado: ausente, tipo, +x e symlink externo', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    const asset = path.join(gstackRoot, 'bin', 'gstack-review-read');
    const original = fs.readFileSync(asset);
    const assertRuntimeFail = (label) => {
      const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
      assert.match(
        result.stdout,
        /FAIL\s+Cursor gstack runtime wrapper is misplaced or has unexpected provenance/,
        `${label}\n${result.stdout}`,
      );
      assert.strictEqual(result.code, 1, `${label}\n${result.stdout}`);
    };
    const restoreAsset = () => {
      fs.writeFileSync(asset, original);
      fs.chmodSync(asset, 0o755);
    };

    fs.unlinkSync(asset);
    assertRuntimeFail('bin referenciado ausente');
    restoreAsset();

    fs.unlinkSync(asset);
    fs.mkdirSync(asset);
    assertRuntimeFail('bin referenciado com tipo errado');
    fs.rmdirSync(asset);
    restoreAsset();

    fs.chmodSync(asset, 0o644);
    assertRuntimeFail('bin referenciado sem executabilidade');
    fs.chmodSync(asset, 0o755);

    fs.chmodSync(asset, 0o777);
    assertRuntimeFail('bin referenciado group/world-writable');
    fs.chmodSync(asset, 0o755);

    for (const directory of [gstackRoot, path.join(gstackRoot, 'bin'), path.join(gstackRoot, 'lib')]) {
      fs.chmodSync(directory, 0o777);
      assertRuntimeFail(`ancestral runtime group/world-writable: ${path.basename(directory)}`);
      fs.chmodSync(directory, 0o755);
    }

    const launcher = path.join(home, 'cursor-home', 'jarvis-runtime', 'gstack', 'pair-agent');
    fs.chmodSync(launcher, 0o777);
    assertRuntimeFail('launcher pair-agent group/world-writable');
    fs.chmodSync(launcher, 0o755);

    const external = path.join(home, 'external-gstack-binary');
    fs.writeFileSync(external, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(external, 0o755);
    fs.unlinkSync(asset);
    fs.symlinkSync(external, asset);
    assertRuntimeFail('bin referenciado via symlink externo');
    fs.unlinkSync(asset);
    restoreAsset();

    const healthy = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
    assert.strictEqual(healthy.code, 0, healthy.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] ancestral runtime de outro uid falha quando executado como root', {
  skip: typeof process.getuid !== 'function' || process.getuid() !== 0,
}, () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    const binDirectory = path.join(gstackRoot, 'bin');
    fs.chownSync(binDirectory, 1, 1);
    const result = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
    assert.match(
      result.stdout,
      /FAIL\s+Cursor gstack runtime wrapper is misplaced or has unexpected provenance/,
      result.stdout,
    );
    assert.strictEqual(result.code, 1, result.stdout);
    fs.chownSync(binDirectory, 0, 0);
  } finally {
    rmHome(home);
  }
});

test('[doctor] gstack runtime wrapper adulterado → FAIL de proveniência', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const gstackRoot = path.join(home, 'gstack-source');
    createDoctorGstackFixture(gstackRoot, ['gstack-review']);
    bootstrapCursor(home, { gstackRoot });
    fs.writeFileSync(
      path.join(home, 'cursor-home', 'jarvis-runtime', 'gstack', 'unexpected-copy.txt'),
      'must fail\n',
    );

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home'), gstackRoot });
    assert.match(r.stdout, /FAIL\s+Cursor gstack runtime wrapper is misplaced or has unexpected provenance/, r.stdout);
    assert.strictEqual(r.code, 1, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor restrictive permissions → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const permissionsPath = path.join(home, 'cursor-home', 'permissions.json');
    const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
    permissions.approvalMode = 'manual';
    fs.unlinkSync(permissionsPath);
    fs.writeFileSync(permissionsPath, JSON.stringify(permissions, null, 2));

    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+Cursor permissions are not unrestricted/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor hook target dangling → FAIL + exit 1', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const target = path.join(home, 'cursor-home', 'hooks', 'rtk-shell.js');
    fs.unlinkSync(target);
    fs.symlinkSync('/no/such/rtk-shell.js', target);
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(r.stdout, /FAIL\s+Cursor hook target missing:.*rtk-shell\.js/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] arquivos pessoais limpos do Cursor não viram sinal Jarvis', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const ch = path.join(home, 'cursor-home');
    fs.mkdirSync(path.join(ch, 'skills', 'personal-skill'), { recursive: true });
    fs.writeFileSync(path.join(ch, 'mcp.json'), JSON.stringify({
      mcpServers: { personal: { command: 'echo' } },
      metadata: { 'graphify-brain': { command: 'homonym-only' } },
      note: 'arbitrary text: "graphify-brain"',
    }, null, 2));
    fs.writeFileSync(path.join(ch, 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: './hooks/personal.js' }] },
    }, null, 2));
    fs.writeFileSync(path.join(ch, 'permissions.json'), JSON.stringify({
      approvalMode: 'manual',
    }, null, 2));
    fs.writeFileSync(
      path.join(ch, 'skills', 'personal-skill', 'SKILL.md'),
      '---\nname: personal-skill\ndescription: personal\n---\n',
    );
    const r = runDoctor(home, { cursorHome: ch });
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}\n${r.stdout}`);
    assert.match(r.stdout, /WARN\s+Cursor harness not found/, r.stdout);
    assert.doesNotMatch(r.stdout, /FAIL\s+Cursor/, r.stdout);
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor dangling jarvis rule symlink → FAIL (not WARN absent)', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    const ch = path.join(home, 'cursor-home');
    fs.mkdirSync(path.join(ch, 'rules'), { recursive: true });
    fs.symlinkSync('/no/such/jarvis-cortex.mdc', path.join(ch, 'rules', 'jarvis-cortex.mdc'));
    const r = runDoctor(home, { cursorHome: ch });
    assert.match(r.stdout, /FAIL\s+Cursor jarvis-cortex rule dangling/, r.stdout);
    assert.doesNotMatch(r.stdout, /WARN\s+Cursor harness not found/, r.stdout);
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor missing beforeMCPExecution registration → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const hooksPath = path.join(home, 'cursor-home', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    delete hooks.hooks.beforeMCPExecution;
    fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(
      r.stdout,
      /FAIL\s+Cursor hooks\.json missing jarvis hook under beforeMCPExecution:.*enforce-cursor\.js/,
      r.stdout,
    );
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});

test('[doctor] cursor missing rtk-shell under preToolUse → FAIL', () => {
  const home = mkTempHome();
  try {
    bootstrap(home);
    bootstrapCursor(home);
    const hooksPath = path.join(home, 'cursor-home', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    hooks.hooks.preToolUse = (hooks.hooks.preToolUse || []).filter(
      (h) => h.command !== './hooks/rtk-shell.js',
    );
    fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
    const r = runDoctor(home, { cursorHome: path.join(home, 'cursor-home') });
    assert.match(
      r.stdout,
      /FAIL\s+Cursor hooks\.json missing jarvis hook under preToolUse:.*rtk-shell\.js/,
      r.stdout,
    );
    assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}\n${r.stdout}`);
  } finally {
    rmHome(home);
  }
});
