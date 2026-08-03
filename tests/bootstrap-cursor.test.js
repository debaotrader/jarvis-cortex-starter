#!/usr/bin/env node
/**
 * tests/bootstrap-cursor.test.js — regressão do harness Cursor.
 *
 * scripts/bootstrap-cursor.sh wires ~/.cursor (hooks, mcp, rules).
 * Skills are linked natively under CURSOR_HOME/skills so Cursor can keep
 * third-party imports disabled and avoid recursively scanning other agents.
 *
 * Estes testes rodam o script contra um HOME temp e validam:
 *   1. hooks.json + mcp.json + permissions.json válidos
 *   2. graphify-brain presente no mcp
 *   3. hook scripts linkados e resolvem
 *   4. skills Jarvis linkadas uma única vez sob CURSOR_HOME/skills
 *   5. merge idempotente + preservação de MCP manual
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { fork, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-cursor.sh');
const GSTACK_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-gstack-install.mjs');
const CURSOR_COPY_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-skill-copy.mjs');
const CURSOR_TREE_DIGEST_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-tree-digest.mjs');
const CURSOR_AUDIT_TOOL = path.join(REPO_ROOT, 'scripts', 'cursor-skills-audit.mjs');
const CURSOR_ROOT_GUARD = path.join(REPO_ROOT, 'scripts', 'cursor-root-guard.mjs');
// Três testes (busque REAL_GSTACK_SKIP) leem o checkout VIVO do gstack — 1.1GB
// de código de terceiro que ninguém versiona junto. Enquanto bastava ele
// existir, resultado, duração e segurança dependiam da máquina: verde aqui,
// pulado no CI, e nada verificando que a fonte continuou intacta depois. Agora é
// opt-in explícito, e quando ligado a fonte é conferida byte-a-byte no fim
// (realGstackGuard). Desligado, o path nem é lido.
const REAL_GSTACK_ROOT = path.join(os.homedir(), '.gstack', 'repos', 'gstack');
const REAL_GSTACK_OPT_IN = process.env.JARVIS_TEST_REAL_GSTACK === '1';
const HAVE_REAL_GSTACK = REAL_GSTACK_OPT_IN
  && fs.existsSync(path.join(REAL_GSTACK_ROOT, '.cursor', 'skills'))
  && fs.existsSync(path.join(REAL_GSTACK_ROOT, 'bin', 'gstack-memory-ingest.ts'))
  && fs.existsSync(path.join(REAL_GSTACK_ROOT, 'bin', 'gstack-gbrain-sync.ts'));
const REAL_GSTACK_SKIP = REAL_GSTACK_OPT_IN
  ? 'checkout real do gstack indisponível'
  : 'checkout real do gstack: exporte JARVIS_TEST_REAL_GSTACK=1 para habilitar';
const ORIGINAL_TEST_PATH = process.env.PATH || '';
const TEST_BUN_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-bun-'));
fs.writeFileSync(path.join(TEST_BUN_BIN, 'bun'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(TEST_BUN_BIN, 'bun'), 0o755);
process.env.PATH = `${TEST_BUN_BIN}${path.delimiter}${ORIGINAL_TEST_PATH}`;
process.on('exit', () => fs.rmSync(TEST_BUN_BIN, { recursive: true, force: true }));

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

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cursor-'));
}

function cursorThirdPartyFixture(_home, value = 'false') {
  // Root-guard tests require a rejected bootstrap to leave HOME byte-exact.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cursor-third-party-'));
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
    CURSOR_STATE_DB: stateDb,
    bin,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// The fake sqlite3 must survive a caller-supplied PATH (pathWithoutBun).
// Prefix only the fixture's bin so the hand-picked PATH keeps its meaning
// (no bun) while the fixture sqlite3 still shadows the real one — otherwise the
// real sqlite3 reads the plain-text fixture DB and the third-party flag reads
// as unset instead of explicitly disabled.
function composeFixturePath(fixture, callerPath) {
  return callerPath ? `${fixture.bin}${path.delimiter}${callerPath}` : fixture.PATH;
}

function createRootGuardRepo(root) {
  for (const directory of ['cursor/hooks', 'cursor/rules']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const hook of ['rtk-shell.js', 'enforce-cursor.js', 'session-start.js']) {
    const target = path.join(root, 'cursor', 'hooks', hook);
    fs.writeFileSync(target, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    fs.chmodSync(target, 0o755);
  }
  fs.writeFileSync(path.join(root, 'cursor', 'permissions.json'), '{}\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'cursor', 'rules', 'jarvis-cortex.mdc'), '---\nalwaysApply: true\n---\n', { mode: 0o644 });
}

function runRootGuard(command, home, repoRoot, cursorRoot, manifest = '', guard = CURSOR_ROOT_GUARD) {
  return spawnSync(process.execPath, [
    guard, command, cursorRoot, home, repoRoot,
  ], { encoding: 'utf8', input: manifest });
}

function installRootGuardLinks(repoRoot, cursorRoot) {
  const links = [
    ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
    ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
    ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
    ['permissions.json', 'cursor/permissions.json'],
    ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
  ];
  for (const [destination, source] of links) {
    fs.symlinkSync(fs.realpathSync(path.join(repoRoot, source)), path.join(cursorRoot, destination));
  }
}

// Ambiente de fixture do Cursor, em UM lugar só. Todo runner de bootstrap passa
// por aqui: espalhar `...process.env` e pinar caso a caso já deixou
// CURSOR_BACKUP_DIR herdável em dois runners, o que faz backup cair FORA do HOME
// temp — sobrevivendo à limpeza e escrevendo em diretório real da máquina.
// Toda variável que redireciona ESCRITA fica presa ao fixture aqui.
//
// COBERTURA, enumerada mecanicamente (não "as que eu achei lendo" — esta correção
// já foi declarada pronta duas vezes e achada parcial duas vezes):
//
//   grep -nE 'spawnSync|spawn\(|fork\(' tests/bootstrap-cursor.test.js
//
// Dos ~80 sites, os sensíveis a ambiente são SÓ os que executam shell nosso:
//   runBootstrap, runBootstrapAtBarrier, runCursorDoctor, o runner `oldArg`
//   ('antigos hooks argv/fd/env') e o par bootstrap+doctor de
//   'env third-party legado'. Todos passam por aqui.
// Os demais invocam ferramentas .mjs por argv, e essas não leem ambiente nenhum:
//
//   grep -c 'process\.env' scripts/*.mjs   # 14 arquivos, todos 0
//
// Os `bash -c` restantes rodam corpos de fixture auto-contidos (definem as
// próprias variáveis) e o launcher de pair-agent pina HOME. Se um .mjs passar a
// ler ambiente, ou um runner novo aparecer, ele entra aqui.
function cursorFixtureEnv(home, opts = {}) {
  const ch = opts.cursorHome || path.join(home, 'cursor-home');
  return {
    HOME: home,
    CURSOR_HOME: ch,
    CURSOR_BACKUP_DIR: opts.cursorBackupDir || path.join(ch, 'backups'),
    GSTACK_REPO_ROOT: opts.gstackRoot || path.join(home, '.gstack', 'repos', 'gstack'),
    GSTACK_MIGRATED_DIR: path.join(home, '.gstack', 'repos', 'gstack'),
    JARVIS_BRAIN_HOME: path.join(home, '.jarvis-brain-absent'),
    JARVIS_CORTEX_CONFIG: path.join(home, '.jarvis-cortex-config.json'),
    NODE_BIN: process.execPath,
  };
}

function runBootstrap(home, opts = {}) {
  // Use cursor-home (not .cursor) so hermetic fixtures avoid macOS/sandbox
  // special-casing of the literal ".cursor" directory name.
  const script = opts.script || SCRIPT;
  const thirdParty = cursorThirdPartyFixture(home, opts.thirdParty ?? 'false');
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    // This is the ONLY effective hang deadline for a runBootstrap call: spawnSync
    // blocks the event loop, so a node:test `timeout:` option cannot fire while
    // the bootstrap runs. 30s catches genuine hangs on the hermetic fixtures;
    // slow paths (the real gstack checkout) opt in via opts.spawnTimeout rather
    // than raising the ceiling for every caller.
    timeout: opts.spawnTimeout || 30000,
    cwd: path.resolve(path.dirname(script), '..'),
    env: {
      ...process.env,
      ...cursorFixtureEnv(home, opts),
      CURSOR_STATE_DB: thirdParty.CURSOR_STATE_DB,
      PATH: composeFixturePath(thirdParty, opts.path),
      ...(opts.manifestTool ? { CURSOR_MANIFEST_TOOL: opts.manifestTool } : {}),
      ...(opts.copyTool ? { CURSOR_COPY_TOOL: opts.copyTool } : {}),
      ...(opts.gstackTool ? { CURSOR_GSTACK_TOOL: opts.gstackTool } : {}),
      ...(opts.anchoredTool ? { CURSOR_ANCHORED_FS: opts.anchoredTool } : {}),
      ...(opts.nodeOptions ? { NODE_OPTIONS: opts.nodeOptions } : {}),
    },
  });
  thirdParty.cleanup();
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runBootstrapAtBarrier(home, opts, onBarrier) {
  return new Promise((resolve, reject) => {
    const script = opts.script || SCRIPT;
    const thirdParty = cursorThirdPartyFixture(home, opts.thirdParty ?? 'false');
    const child = spawn('bash', [script], {
      cwd: path.resolve(path.dirname(script), '..'),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...cursorFixtureEnv(home, opts),
        CURSOR_STATE_DB: thirdParty.CURSOR_STATE_DB,
        PATH: composeFixturePath(thirdParty, opts.path),
        ...(opts.manifestTool ? { CURSOR_MANIFEST_TOOL: opts.manifestTool } : {}),
        ...(opts.copyTool ? { CURSOR_COPY_TOOL: opts.copyTool } : {}),
        ...(opts.gstackTool ? { CURSOR_GSTACK_TOOL: opts.gstackTool } : {}),
        ...(opts.anchoredTool ? { CURSOR_ANCHORED_FS: opts.anchoredTool } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    let control = '';
    let barrierCount = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bootstrap IPC barrier timed out: ${stderr}`));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdio[3].setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdio[3].on('data', (chunk) => {
      control += chunk;
      while (control.includes('\n')) {
        const end = control.indexOf('\n');
        const name = control.slice(0, end);
        control = control.slice(end + 1);
        barrierCount += 1;
        try {
          const reply = onBarrier(name);
          child.stdio[4].write(`${reply || name}\n`);
        } catch (error) {
          reject(error);
          child.kill();
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      thirdParty.cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      thirdParty.cleanup();
      if (barrierCount === 0) {
        reject(new Error(`bootstrap exited before IPC barrier (${code}): ${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function instrumentBootstrapBarrier(script, name) {
  // The `command ` prefix is part of the needle on purpose: bootstrap-cursor.sh
  // invokes NODE_BIN through `command` at every unconditional site, and this
  // literal must track the source exactly or the replace below silently
  // instruments nothing. A count mismatch here is a harness break, not a
  // behaviour failure — it fires before any assertion about what the script does.
  const needle = 'MANIFEST_EXPECTATION="$(command "$NODE_BIN" "$CURSOR_ANCHORED_FS" snapshot-private';
  const source = fs.readFileSync(script, 'utf8');
  assert.strictEqual(source.split(needle).length, 2, `${name}: terminal publish needle`);
  const barrier = [
    `printf '%s\\n' '${name}' >&3`,
    'IFS= read -r JARVIS_TEST_REPLY <&4',
    `[ "$JARVIS_TEST_REPLY" = '${name}' ] || exit 97`,
  ].join('\n');
  fs.writeFileSync(script, source.replace(needle, `${barrier}\n${needle}`));
}

function instrumentTerminalPublishFailure(tool, transition) {
  const needles = {
    'before-old-move': "      const target = fs.lstatSync(targetName, { throwIfNoEntry: false });",
    'after-old-move': "        manifestState = 'old-moved';\n        requireEntryRecord(previousName, previousManifest, 'previous manifest');",
    'after-new-move': '    const installedManifest = privateFileSnapshot(homeAnchor, targetName);',
    postverify: "    manifestState = 'postverified';",
  };
  const needle = needles[transition];
  assert.ok(needle, `unknown manifest transition ${transition}`);
  const source = fs.readFileSync(tool, 'utf8');
  assert.strictEqual(source.split(needle).length, 2, `${transition}: terminal state needle`);
  const failure = `throw new Error(${JSON.stringify(`fixture terminal failure: ${transition}`)});`;
  const replacement = transition === 'after-old-move' || transition === 'postverify'
    ? `${needle}\n    ${failure}`
    : `    ${failure}\n${needle}`;
  fs.writeFileSync(tool, source.replace(needle, replacement));
}

function instrumentTerminalSourceMutation(tool, sourcePath) {
  const needle = '    const installedManifest = privateFileSnapshot(homeAnchor, targetName);';
  const source = fs.readFileSync(tool, 'utf8');
  assert.strictEqual(source.split(needle).length, 2, 'terminal source mutation needle');
  const mutation = `    fs.appendFileSync(${JSON.stringify(path.join(sourcePath, 'SKILL.md'))}, '\\nTERMINAL_SOURCE_MUTATION\\n');`;
  fs.writeFileSync(tool, source.replace(needle, `${mutation}\n${needle}`));
}

function instrumentInstallerBarriers(tool) {
  let source = fs.readFileSync(tool, 'utf8');
  const channel = path.basename(tool) === 'cursor-skill-copy.mjs' ? 'Copy' : 'Gstack';
  const helper = `
async function jarvisFixtureBarrier(name, payload = {}) {
  if (typeof process.send !== 'function' || !process.connected) throw new Error('fixture IPC unavailable');
  process.send({ jarvisCursor${channel}Barrier: name, ...payload });
  await new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.jarvisCursor${channel}Continue !== name) return;
      process.off('disconnect', onDisconnect);
      process.off('message', onMessage);
      resolve();
    };
    const onDisconnect = () => reject(new Error('fixture IPC disconnected'));
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}
`;
  source = source.replace("'use strict';", `'use strict';${helper}`);
  const renderNeedle = '  withAnchoredDirectory(staged.anchor, () => {\n    fs.chmodSync';
  const markerNeedle = channel === 'Copy'
    ? '  writePrivateAnchoredFile(staged.anchor, MARKER, markerContent);'
    : '  writePrivateAnchoredFile(staged.anchor, SKILL_MARKER, markerContent);';
  const commitNeedle = '  assertDirectoryLookup(parentAnchor);\n  transactionToken = commitAnchoredStage({';
  const afterCommitNeedle = '  const committedAnchor = { ...staged.anchor, lookup: target };';
  for (const [needle, replacement] of [
    [renderNeedle, `  await jarvisFixtureBarrier('before-root-chmod', { stageLookup: staged.anchor.lookup });\n${renderNeedle}`],
    [markerNeedle, `  await jarvisFixtureBarrier('before-marker', { stageLookup: staged.anchor.lookup });\n${markerNeedle}`],
    [commitNeedle, `  await jarvisFixtureBarrier('before-commit', { parentLookup: parentAnchor.lookup, stageName: staged.name, targetName: tupleName });\n${commitNeedle}`],
    [afterCommitNeedle, `  await jarvisFixtureBarrier('after-commit', { parentLookup: parentAnchor.lookup, targetName: tupleName, transactionToken });\n${afterCommitNeedle}`],
  ]) {
    assert.strictEqual(source.split(needle).length, 2, `${channel}: ${needle}`);
    source = source.replace(needle, replacement);
  }
  fs.writeFileSync(tool, source);
}

function runInstallerAtBarrier(tool, args, onBarrier) {
  return new Promise((resolve, reject) => {
    const child = fork(tool, args, {
      silent: true,
      env: {
        ...process.env,
        PATH: process.env.PATH,
      },
    });
    let stdout = '';
    let stderr = '';
    let barrierCount = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`installer IPC barrier timed out: ${stderr}`));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('message', (message) => {
      const name = message?.jarvisCursorCopyBarrier || message?.jarvisCursorGstackBarrier;
      if (!name) return;
      barrierCount += 1;
      try {
        onBarrier(name, message);
        child.send(message.jarvisCursorCopyBarrier
          ? { jarvisCursorCopyContinue: name }
          : { jarvisCursorGstackContinue: name });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        child.kill();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (barrierCount === 0) {
        reject(new Error(`installer exited before IPC barrier (${code}): ${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// O doctor é um runner de bootstrap como qualquer outro: passa por
// cursorFixtureEnv. A lista pinada à mão que vivia aqui esquecia
// CURSOR_BACKUP_DIR, GSTACK_MIGRATED_DIR, JARVIS_BRAIN_HOME e
// JARVIS_CORTEX_CONFIG — e doctor.sh LÊ as duas últimas, então o resultado
// dependia do que a máquina do dev tivesse no ambiente. Medido com um doctor.sh
// substituído por `env >> dump`: as quatro chegavam com valor do ambiente.
// As específicas do doctor entram DEPOIS do spread (não substituem o fixture:
// cursorFixtureEnv não fornece CLAUDE_HOME/CODEX_HOME/AGENTS_TARGET_SKILLS).
function runCursorDoctor(home, script, cursorRoot) {
  const thirdParty = cursorThirdPartyFixture(home, 'false');
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ...cursorFixtureEnv(home, { cursorHome: cursorRoot }),
      CLAUDE_HOME: path.join(home, '.claude-absent'),
      CODEX_HOME: path.join(home, '.codex-absent'),
      AGENTS_TARGET_SKILLS: path.join(home, '.agents', 'skills'),
      JARVIS_BRAIN_OPTIONAL: '1',
      CURSOR_STATE_DB: thirdParty.CURSOR_STATE_DB,
      PATH: thirdParty.PATH,
    },
  });
  thirdParty.cleanup();
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

function corruptLinkSkillSource(repoRoot, outsideRoot, variant) {
  const skill = path.join(repoRoot, 'active', 'skills', 'dead-code-audit');
  if (variant === 'source-directory') {
    const external = path.join(outsideRoot, 'external-dead-code-audit');
    fs.renameSync(skill, external);
    fs.symlinkSync(external, skill);
    return { external, restore() { fs.unlinkSync(skill); fs.renameSync(external, skill); } };
  }
  if (variant === 'intermediate-directory') {
    const skills = path.dirname(skill);
    const external = path.join(outsideRoot, 'external-active-skills');
    fs.renameSync(skills, external);
    fs.symlinkSync(external, skills);
    return { external, restore() { fs.unlinkSync(skills); fs.renameSync(external, skills); } };
  }
  const skillFile = path.join(skill, 'SKILL.md');
  const external = path.join(outsideRoot, 'external-dead-code-audit-SKILL.md');
  fs.renameSync(skillFile, external);
  fs.symlinkSync(external, skillFile);
  return { external, restore() { fs.unlinkSync(skillFile); fs.renameSync(external, skillFile); } };
}

function cursorHome(home) {
  return path.join(home, 'cursor-home');
}

function snapshotTree(candidate) {
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return null;
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return { type: 'link', mode, target: fs.readlinkSync(candidate) };
  if (stat.isDirectory()) {
    return {
      type: 'directory',
      mode,
      entries: Object.fromEntries(
        fs.readdirSync(candidate).sort().map((entry) => [entry, snapshotTree(path.join(candidate, entry))]),
      ),
    };
  }
  return { type: 'file', mode, content: fs.readFileSync(candidate).toString('base64') };
}

// Guarda pros testes opt-in que leem o checkout real do gstack: fotografa as
// subárvores que as ferramentas tocam (`.cursor/skills` é a fonte copiada, `bin`
// é o que o runtime-sync espelha) e confere byte + modo no fim. Rodar contra uma
// árvore de terceiro sem verificar que ela sobreviveu é a mesma omissão que
// deixou o dano em cursor/hooks/rtk-shell.js passar: exit code certo, estrago em
// outro lugar. Só as duas subárvores, não os 1.1GB: é o que é lido.
function realGstackGuard() {
  const roots = [
    path.join(REAL_GSTACK_ROOT, '.cursor', 'skills'),
    path.join(REAL_GSTACK_ROOT, 'bin'),
  ];
  const before = roots.map((root) => snapshotTree(root));
  return () => roots.forEach((root, index) => {
    assert.deepStrictEqual(snapshotTree(root), before[index],
      `o checkout real do gstack foi modificado: ${root}`);
  });
}

const TEST_SHELL_PATH_PATTERNS = [
  /^\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack-state(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$HOME\$(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$\{(?:GSTACK_ROOT|GSTACK_BIN|GSTACK_BROWSE|GSTACK_DESIGN|GSTACK_MAKE_PDF)\}(?:\/[A-Za-z0-9._/-]*)?/,
  /^\$(?:B|D|P)(?![A-Za-z0-9_])/,
  /^\$\{(?:B|D|P)\}/,
];

function testRuntimePathAt(content, index) {
  const suffix = content.slice(index);
  for (const pattern of TEST_SHELL_PATH_PATTERNS) {
    const match = suffix.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}

function testContainsRuntimePath(content) {
  for (let index = 0; index < content.length; index += 1) {
    if (testRuntimePathAt(content, index)) return true;
  }
  return false;
}

function testFenceOpening(line) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)(?:\n|$)/);
  if (!match) return null;
  const info = match[3].replace(/\r$/, '');
  if (match[2][0] === '`' && info.includes('`')) return null;
  return {
    character: match[2][0],
    width: match[2].length,
    language: info.trim().split(/[ \t]+/, 1)[0].toLowerCase(),
  };
}

function testFenceClosing(line, fence) {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/);
  return Boolean(match && match[2][0] === fence.character && match[2].length >= fence.width);
}

function testHeredocRanges(content) {
  const lines = [];
  let offset = 0;
  for (const line of content.match(/.*(?:\n|$)/g).filter(Boolean)) {
    lines.push({ text: line, start: offset, end: offset + line.length });
    offset += line.length;
  }
  const ranges = [];
  const arithmeticRanges = [];
  for (let index = 0; index < content.length - 1; index += 1) {
    const openerWidth = content.slice(index, index + 3) === '$(('
      ? 3
      : content.slice(index, index + 2) === '((' ? 2 : 0;
    if (openerWidth === 0) continue;
    const start = index;
    let groups = 0;
    index += openerWidth;
    for (; index < content.length; index += 1) {
      if (content[index] === '\\') index += 1;
      else if (content[index] === '(') groups += 1;
      else if (content[index] === ')' && groups > 0) groups -= 1;
      else if (content[index] === ')' && content[index + 1] === ')') {
        arithmeticRanges.push({ start, end: index + 2 });
        index += 1;
        break;
      }
    }
  }
  const operator = /(^|[^<])<<(-?)(?!<)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\([^\s;&|()<>]+)|([^\s;&|()<>]+))/g;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const pending = [];
    operator.lastIndex = 0;
    for (const match of lines[lineIndex].text.matchAll(operator)) {
      const operatorOffset = lines[lineIndex].start + match.index + match[1].length;
      if (arithmeticRanges.some(({ start, end }) => operatorOffset >= start && operatorOffset < end)) {
        continue;
      }
      pending.push({
        stripTabs: match[2] === '-',
        delimiter: match[3] || match[4] || match[5] || match[6],
      });
    }
    if (pending.length === 0) continue;
    let cursor = lineIndex + 1;
    for (const heredoc of pending) {
      const bodyStart = cursor < lines.length ? lines[cursor].start : content.length;
      let found = false;
      while (cursor < lines.length) {
        let candidate = lines[cursor].text.replace(/\n$/, '').replace(/\r$/, '');
        if (heredoc.stripTabs) candidate = candidate.replace(/^\t+/, '');
        if (candidate === heredoc.delimiter) {
          ranges.push({ start: bodyStart, end: lines[cursor].end });
          cursor += 1;
          found = true;
          break;
        }
        cursor += 1;
      }
      if (!found) {
        ranges.push({ start: bodyStart, end: content.length });
        cursor = lines.length;
        break;
      }
    }
    lineIndex = Math.max(lineIndex, cursor - 1);
  }
  return ranges;
}

function testHeredocBodies(content) {
  return testHeredocRanges(content).map(({ start, end }) => content.slice(start, end));
}

function testBacktickEnd(content, start) {
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === '\\') index += 1;
    else if (content[index] === '`') return index;
  }
  return -1;
}

function testCommandSubstitutionEnd(content, start) {
  let quote = null;
  let groups = 0;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      else if (character === '$' && content[index + 1] === '(') {
        const end = testCommandSubstitutionEnd(content, index + 2);
        if (end < 0) return -1;
        index = end;
      } else if (character === '`') {
        const end = testBacktickEnd(content, index + 1);
        if (end < 0) return -1;
        index = end;
      }
      continue;
    }
    if (character === '\\') index += 1;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '`') {
      const end = testBacktickEnd(content, index + 1);
      if (end < 0) return -1;
      index = end;
    } else if (character === '$' && content[index + 1] === '(') {
      const end = testCommandSubstitutionEnd(content, index + 2);
      if (end < 0) return -1;
      index = end;
    } else if (character === '(') groups += 1;
    else if (character === ')' && groups === 0) return index;
    else if (character === ')') groups -= 1;
  }
  return -1;
}

function unsafeRuntimeShellReferences(content, label) {
  const unsafe = [];
  const protectedRanges = testHeredocRanges(content);
  let protectedIndex = 0;
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    while (protectedIndex < protectedRanges.length && protectedRanges[protectedIndex].end <= index) {
      protectedIndex += 1;
    }
    if (protectedRanges[protectedIndex]?.start === index) {
      index = protectedRanges[protectedIndex].end - 1;
      protectedIndex += 1;
      continue;
    }
    const character = content[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === '$' && content[index + 1] === '(') {
        const end = testCommandSubstitutionEnd(content, index + 2);
        if (end >= 0) {
          unsafe.push(...unsafeRuntimeShellReferences(content.slice(index + 2, end), label));
          index = end;
        }
      } else if (character === '`') {
        const end = testBacktickEnd(content, index + 1);
        if (end >= 0) {
          unsafe.push(...unsafeRuntimeShellReferences(content.slice(index + 1, end), label));
          index = end;
        }
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /[\n\s;&|()<>]/.test(content[index - 1]))) {
      const newline = content.indexOf('\n', index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (character === '`') {
      const end = testBacktickEnd(content, index + 1);
      if (end >= 0) {
        unsafe.push(...unsafeRuntimeShellReferences(content.slice(index + 1, end), label));
        index = end;
        continue;
      }
    }
    const match = testRuntimePathAt(content, index);
    if (match) {
      unsafe.push(`${label}: ${match}`);
      index += match.length - 1;
    }
  }
  return unsafe;
}

function unsafeRuntimeReferencesInMarkdown(content, label) {
  const unsafe = [];
  const lines = content.match(/.*(?:\n|$)/g).filter(Boolean);
  let fence = null;
  let shellFence = false;
  let body = [];
  for (const line of lines) {
    if (!fence) {
      const opening = testFenceOpening(line);
      if (opening) {
        fence = opening;
        shellFence = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal'])
          .has(opening.language);
        body = [];
        continue;
      }
      for (const match of line.matchAll(/(`+)(.+?)\1/g)) {
        if (/[\s;&|<>()=]/.test(match[2]) && testContainsRuntimePath(match[2])) {
          unsafe.push(...unsafeRuntimeShellReferences(match[2], `${label}:inline`));
        }
      }
      continue;
    }
    if (testFenceClosing(line, fence)) {
      if (shellFence) unsafe.push(...unsafeRuntimeShellReferences(body.join(''), `${label}:fence`));
      fence = null;
      shellFence = false;
      body = [];
    } else body.push(line);
  }
  return unsafe;
}

function shellFenceBodies(content) {
  const bodies = [];
  const lines = content.match(/.*(?:\n|$)/g).filter(Boolean);
  let fence = null;
  let shellFence = false;
  let body = [];
  for (const line of lines) {
    if (!fence) {
      const opening = testFenceOpening(line);
      if (!opening) continue;
      fence = opening;
      shellFence = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal'])
        .has(opening.language);
      body = [];
    } else if (testFenceClosing(line, fence)) {
      if (shellFence) bodies.push(body.join(''));
      fence = null;
      shellFence = false;
      body = [];
    } else body.push(line);
  }
  if (fence && shellFence) bodies.push(body.join(''));
  return bodies;
}

function markdownHeredocBodies(content) {
  return shellFenceBodies(content).flatMap(testHeredocBodies);
}

function createGstackFixture(gstackRoot, names) {
  const generated = path.join(gstackRoot, '.cursor', 'skills');
  for (const asset of [
    'bin', 'browse/dist', 'browse/bin', 'design/dist', 'design-html/vendor', 'extension', 'gstack-upgrade',
    'lib', 'plan-ceo-review', 'plan-devex-review', 'review',
  ]) fs.mkdirSync(path.join(gstackRoot, asset), { recursive: true });
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-config'), '#!/bin/sh\nprintf "true\\n"\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-config'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-update-check'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-update-check'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'bin', 'gstack-review-read'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'bin', 'gstack-review-read'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'browse', 'dist', 'browse'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const localIndex = args.indexOf('--local');
if (args[0] === 'pair-agent' && localIndex >= 0) {
  const host = args[localIndex + 1];
  const configDir = path.join(
    process.env.HOME,
    \`.\${host}/skills/gstack\`,
  );
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'browse-remote.json'), '{"fixture":"local-only"}\\n', { mode: 0o600 });
}
`);
  fs.chmodSync(path.join(gstackRoot, 'browse', 'dist', 'browse'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'browse', 'bin', 'remote-slug'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'browse', 'bin', 'remote-slug'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'design', 'dist', 'design'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(gstackRoot, 'design', 'dist', 'design'), 0o755);
  fs.writeFileSync(path.join(gstackRoot, 'gstack-upgrade', 'SKILL.md'), '---\nname: gstack-upgrade\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(gstackRoot, 'ETHOS.md'), '# Search before building\n');
  fs.writeFileSync(path.join(gstackRoot, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(gstackRoot, 'review', 'checklist.md'), '# Checklist\n');
  fs.writeFileSync(path.join(gstackRoot, 'review', 'TODOS-format.md'), '# TODO format\n');
  fs.writeFileSync(path.join(gstackRoot, 'plan-ceo-review', 'SKILL.md'), '---\nname: plan-ceo-review-runtime\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(gstackRoot, 'plan-devex-review', 'SKILL.md'), '---\nname: plan-devex-review-runtime\ndescription: fixture\n---\n');
  fs.writeFileSync(path.join(gstackRoot, 'plan-devex-review', 'dx-hall-of-fame.md'), '# DX hall of fame\n');
  fs.writeFileSync(path.join(gstackRoot, 'lib', 'diagram-render'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(gstackRoot, 'lib', 'redact-audit-log.ts'), 'export const redact = true;\n');
  fs.writeFileSync(path.join(gstackRoot, 'design-html', 'vendor', 'pretext.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(gstackRoot, 'extension', 'package.json'), '{"name":"gstack-extension-fixture"}\n');
  fs.writeFileSync(path.join(gstackRoot, 'extension', 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(gstackRoot, 'sensitive-canary.fixture'), 'DO_NOT_COPY_CANARY\n');
  for (const entry of names) {
    const sourceLeaf = typeof entry === 'string' ? entry : entry.sourceLeaf;
    const name = typeof entry === 'string' ? entry : entry.name;
    assert.match(sourceLeaf, /^gstack(?:-|$)/, 'fixture source leaf must model the gstack catalog');
    assert.match(name, /^[A-Za-z0-9._-]+$/, 'fixture target/frontmatter name must be explicit');
    const source = path.join(generated, sourceLeaf);
    fs.mkdirSync(source, { recursive: true });
    const lines = [
      '---',
      `name: ${name}`,
      'description: fixture',
      '---',
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
      '```',
    ];
    if (sourceLeaf === 'gstack-pair-agent') {
      lines.push(
        'Missing `$GSTACK_ROOT/.feature-prompted-continuous-checkpoint`; always touch marker.',
        'Missing `$GSTACK_ROOT/.feature-prompted-model-overlay`; always touch marker.',
        '```bash',
        '$B pair-agent --local TARGET_HOST',
        '```',
        'Cursor credentials are written to `~/.cursor/skills/gstack/browse-remote.json`.',
      );
    }
    if (sourceLeaf === 'gstack-review') {
      lines.push(
        'Read `$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md`.',
        'Read `~/.cursor/skills/gstack/plan-ceo-review/SKILL.md`.',
        'Run `$HOME/.cursor/skills/gstack/lib/redact-audit-log.ts`.',
        'Load `${HOME}/.cursor/skills/gstack/extension/manifest.json`.',
        'Read `$GSTACK_ROOT/review/checklist.md`.',
      );
    }
    lines.push('');
    fs.writeFileSync(path.join(source, 'SKILL.md'), lines.join('\n'));
  }
  return generated;
}

function createFilteredManifestTool(home, omittedNames) {
  const tool = path.join(home, 'filtered-cursor-manifest.mjs');
  fs.writeFileSync(tool, [
    "import { spawnSync } from 'node:child_process';",
    `const omitted = new Set(${JSON.stringify(omittedNames)});`,
    `const realTool = ${JSON.stringify(path.join(REPO_ROOT, 'scripts', 'cursor-skill-manifest.mjs'))};`,
    'const result = spawnSync(process.execPath, [realTool, ...process.argv.slice(2)], { encoding: "utf8" });',
    'if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }',
    'for (const line of result.stdout.split(/\\n/)) {',
    '  if (!line) continue;',
    '  if (!omitted.has(line.split("\\t")[0])) process.stdout.write(`${line}\\n`);',
    '}',
    '',
  ].join('\n'));
  return tool;
}

test('[cursor] bootstrap cria hooks.json/mcp.json/permissions.json válidos', () => {
  const home = freshHome();
  try {
    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou: ${r.stderr}\n${r.stdout}`);
    const ch = cursorHome(home);
    const hooks = JSON.parse(fs.readFileSync(path.join(ch, 'hooks.json'), 'utf8'));
    const mcp = JSON.parse(fs.readFileSync(path.join(ch, 'mcp.json'), 'utf8'));
    const permissions = JSON.parse(fs.readFileSync(path.join(ch, 'permissions.json'), 'utf8'));
    assert.strictEqual(hooks.version, 1);
    assert.ok(hooks.hooks.sessionStart?.length >= 1);
    assert.ok(hooks.hooks.preToolUse?.length >= 2);
    assert.ok(mcp.mcpServers['graphify-brain']);
    assert.ok(mcp.mcpServers.playwright);
    assert.strictEqual(mcp.mcpServers.MetaAds.url, 'https://mcp.facebook.com/ads');
    assert.strictEqual(permissions.approvalMode, 'unrestricted');
    assert.deepStrictEqual(permissions.terminalAllowlist, ['*']);
    assert.deepStrictEqual(permissions.mcpAllowlist, ['*:*']);
    assert.ok(fs.lstatSync(ch).isDirectory());
    assert.strictEqual(fs.lstatSync(ch).isSymbolicLink(), false);
    assert.ok(fs.lstatSync(path.join(ch, 'skills')).isDirectory());
    assert.strictEqual(fs.lstatSync(path.join(ch, 'skills')).isSymbolicLink(), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] checkout invocado por ~/.codex/jarvis-cortex symlink persiste sources canônicos', () => {
  const home = freshHome();
  try {
    const codexHome = path.join(home, '.codex');
    const checkoutAlias = path.join(codexHome, 'jarvis-cortex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.symlinkSync(REPO_ROOT, checkoutAlias);

    const result = runBootstrap(home, {
      script: path.join(checkoutAlias, 'scripts', 'bootstrap-cursor.sh'),
    });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);

    const manifest = fs.readFileSync(
      path.join(cursorHome(home), 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    );
    const physicalRoot = fs.realpathSync(REPO_ROOT);
    const aliasPrefix = `${checkoutAlias}${path.sep}`;
    for (const line of manifest.trim().split('\n')) {
      const [, source, , provenance] = line.split('\t');
      if (provenance === 'gstack') continue;
      assert.ok(source.startsWith(`${physicalRoot}${path.sep}`), source);
      assert.ok(!source.startsWith(aliasPrefix), `manifest leaked logical alias: ${source}`);
      assert.strictEqual(fs.realpathSync(source), source, `source is not canonical: ${source}`);
    }
    assert.strictEqual(
      fs.realpathSync(path.join(cursorHome(home), 'hooks', 'session-start.js')),
      path.join(physicalRoot, 'cursor', 'hooks', 'session-start.js'),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] root guard ensure/verify exigem hooks-fonte executáveis sem mutar destino', () => {
  for (const command of ['ensure', 'verify']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      const ch = path.join(home, `cursor-${command}`);
      createRootGuardRepo(repoRoot);
      if (command === 'verify') {
        const prepared = runRootGuard('ensure', home, repoRoot, ch);
        assert.strictEqual(prepared.status, 0, prepared.stderr);
        installRootGuardLinks(repoRoot, ch);
        assert.strictEqual(runRootGuard('verify', home, repoRoot, ch).status, 0);
      }
      const hook = path.join(repoRoot, 'cursor', 'hooks', 'rtk-shell.js');
      fs.chmodSync(hook, 0o644);
      const before = snapshotTree(ch);

      const result = runRootGuard(command, home, repoRoot, ch);
      assert.notStrictEqual(result.status, 0, `${command}\n${result.stderr}`);
      assert.match(result.stderr, /expected hook source is not executable/);
      assert.deepStrictEqual(snapshotTree(ch), before, `${command} não pode mutar CURSOR_HOME`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] fixed links aceitam só raw absoluto/relativo exato; ensure repara aliases sem tocar fontes', () => {
  const home = freshHome();
  const fixed = [
    ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
    ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
    ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
    ['permissions.json', 'cursor/permissions.json'],
    ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
  ];
  try {
    const ch = cursorHome(home);
    const first = runBootstrap(home);
    assert.strictEqual(first.code, 0, `${first.stderr}\n${first.stdout}`);

    const installSpelling = (spelling) => {
      for (const [destination, source] of fixed) {
        const target = path.join(ch, destination);
        const expected = path.join(REPO_ROOT, source);
        fs.unlinkSync(target);
        fs.symlinkSync(spelling(target, expected), target);
      }
    };

    installSpelling((_target, expected) => expected);
    assert.strictEqual(runRootGuard('verify', home, REPO_ROOT, ch).status, 0,
      'canonical absolute spelling must pass');

    installSpelling((target, expected) => path.relative(fs.realpathSync(path.dirname(target)), expected));
    const relativeVerified = runRootGuard('verify', home, REPO_ROOT, ch);
    assert.strictEqual(relativeVerified.status, 0,
      `exact path.relative spelling must pass\n${relativeVerified.stderr}`);

    const checkoutAlias = path.join(home, 'cortex-alias');
    fs.symlinkSync(REPO_ROOT, checkoutAlias);
    const aliases = new Map([
      ['checkout alias', (_target, expected) => path.join(checkoutAlias, path.relative(REPO_ROOT, expected))],
      ['dot component', (target, expected) =>
        `./${path.relative(fs.realpathSync(path.dirname(target)), expected)}`],
      ['parent component', (_target, expected) => {
        const parent = path.dirname(expected);
        return `${parent}/../${path.basename(parent)}/${path.basename(expected)}`;
      }],
      ['duplicate slash', (_target, expected) => `${path.dirname(expected)}//${path.basename(expected)}`],
    ]);
    const sourceSnapshots = new Map(fixed.map(([, source]) => {
      const absolute = path.join(REPO_ROOT, source);
      return [absolute, fs.readFileSync(absolute)];
    }));

    for (const [label, spelling] of aliases) {
      installSpelling(spelling);
      const rejected = runRootGuard('verify', home, REPO_ROOT, ch);
      assert.notStrictEqual(rejected.status, 0, `${label} should fail verify`);
      assert.match(rejected.stderr, /does not use its exact managed source spelling/, label);

      const ensured = runRootGuard('ensure', home, REPO_ROOT, ch);
      assert.strictEqual(ensured.status, 0, `${label}: ensure must allow safe replacement\n${ensured.stderr}`);
      const repaired = runBootstrap(home);
      assert.strictEqual(repaired.code, 0, `${label}\n${repaired.stderr}\n${repaired.stdout}`);
      for (const [destination, source] of fixed) {
        const target = path.join(ch, destination);
        const expected = path.join(REPO_ROOT, source);
        assert.strictEqual(fs.readlinkSync(target), expected, `${label}: ${destination}`);
        assert.deepStrictEqual(fs.readFileSync(expected), sourceSnapshots.get(expected),
          `${label}: source mutated: ${source}`);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] root guard ensure/verify rejeitam componente-fonte symlink e preservam externo imutável', () => {
  for (const command of ['ensure', 'verify']) {
    const home = freshHome();
    let external;
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      const ch = path.join(home, `cursor-${command}`);
      createRootGuardRepo(repoRoot);
      if (command === 'verify') {
        const prepared = runRootGuard('ensure', home, repoRoot, ch);
        assert.strictEqual(prepared.status, 0, prepared.stderr);
        installRootGuardLinks(repoRoot, ch);
        assert.strictEqual(runRootGuard('verify', home, repoRoot, ch).status, 0);
      }

      external = path.join(home, 'external-immutable-hooks');
      fs.renameSync(path.join(repoRoot, 'cursor', 'hooks'), external);
      fs.symlinkSync(external, path.join(repoRoot, 'cursor', 'hooks'));
      for (const entry of fs.readdirSync(external)) fs.chmodSync(path.join(external, entry), 0o555);
      fs.chmodSync(external, 0o555);
      const beforeCursor = snapshotTree(ch);
      const beforeExternal = snapshotTree(external);

      const result = runRootGuard(command, home, repoRoot, ch);
      assert.notStrictEqual(result.status, 0, `${command}\n${result.stderr}`);
      assert.match(result.stderr, /expected source path contains a symlink/);
      assert.deepStrictEqual(snapshotTree(ch), beforeCursor, `${command}: CURSOR_HOME mutado`);
      assert.deepStrictEqual(snapshotTree(external), beforeExternal, `${command}: externo mutado`);
    } finally {
      if (external && fs.lstatSync(external, { throwIfNoEntry: false })) fs.chmodSync(external, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] link skills exigem source tree real e seguro antes de manifest/ensure/verify/bootstrap', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    const outside = path.join(home, 'outside-source');
    fs.mkdirSync(outside);
    copyCortexFixture(repoRoot);
    const repoCanonical = fs.realpathSync(repoRoot);
    const fixtureManifest = path.join(repoRoot, 'scripts', 'cursor-skill-manifest.mjs');
    const fixtureGuard = path.join(repoRoot, 'scripts', 'cursor-root-guard.mjs');
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');

    for (const variant of ['source-directory', 'intermediate-directory', 'skill-file']) {
      const verifyHome = path.join(home, `cursor-verify-${variant}`);
      const prepared = runRootGuard('ensure', home, repoCanonical, verifyHome, '', fixtureGuard);
      assert.strictEqual(prepared.status, 0, prepared.stderr);
      installRootGuardLinks(repoRoot, verifyHome);
      assert.strictEqual(runRootGuard('verify', home, repoCanonical, verifyHome, '', fixtureGuard).status, 0);

      const installedHome = path.join(home, `cursor-installed-${variant}`);
      const installedPrepared = runRootGuard('ensure', home, repoCanonical, installedHome, '', fixtureGuard);
      assert.strictEqual(installedPrepared.status, 0, installedPrepared.stderr);
      installRootGuardLinks(repoRoot, installedHome);
      const source = fs.realpathSync(path.join(repoRoot, 'active', 'skills', 'dead-code-audit'));
      const row = `dead-code-audit\t${source}\tlink\tcortex\n`;
      fs.writeFileSync(path.join(installedHome, 'jarvis-cortex-skills.manifest.tsv'), row);
      fs.symlinkSync(source, path.join(installedHome, 'skills', 'dead-code-audit'));

      const corrupted = corruptLinkSkillSource(repoRoot, outside, variant);
      try {
        const externalBefore = snapshotTree(corrupted.external);

        const generated = spawnSync(process.execPath, [
          fixtureManifest, repoRoot, path.join(home, 'missing-gstack'),
        ], { encoding: 'utf8' });
        assert.strictEqual(generated.status, 1, `${variant}\n${generated.stderr}`);
        assert.strictEqual(generated.stdout, '', `${variant}: manifest stdout must remain atomic`);
        assert.match(
          generated.stderr,
          /Cursor (?:link skill|skill catalog) dead-code-audit(?: SKILL\.md is not a real regular file| path contains a symlink)|Cursor skill catalog SKILL\.md is not a real regular file: dead-code-audit/,
        );

        for (const command of ['ensure', 'verify']) {
          const ch = command === 'verify' ? verifyHome : path.join(home, `cursor-ensure-${variant}`);
          const before = snapshotTree(ch);
          const guarded = runRootGuard(command, home, repoCanonical, ch, row, fixtureGuard);
          assert.notStrictEqual(guarded.status, 0, `${variant}/${command}`);
          assert.match(
            guarded.stderr,
            /link skill source dead-code-audit(?: SKILL\.md is not a real regular file| path contains a symlink)/,
          );
          assert.deepStrictEqual(snapshotTree(ch), before, `${variant}/${command}: destination mutated`);

          const installedBefore = snapshotTree(installedHome);
          const installedGuard = runRootGuard(command, home, repoCanonical, installedHome, '', fixtureGuard);
          assert.notStrictEqual(installedGuard.status, 0, `${variant}/${command}/installed`);
          assert.match(
            installedGuard.stderr,
            /(?:(?:installed link skill|stale link) source dead-code-audit(?: SKILL\.md is not a real regular file| path contains a symlink)|Cursor skill catalog SKILL\.md is not a real regular file: dead-code-audit)/,
          );
          assert.deepStrictEqual(
            snapshotTree(installedHome),
            installedBefore,
            `${variant}/${command}: installed destination mutated`,
          );
        }

        const bootstrapHome = path.join(home, `bootstrap-${variant}`);
        fs.mkdirSync(bootstrapHome);
        const bootstrapped = runBootstrap(bootstrapHome, { script: fixtureBootstrap });
        assert.notStrictEqual(bootstrapped.code, 0, `${variant}\n${bootstrapped.stderr}`);
        assert.match(
          bootstrapped.stderr,
          /Cursor (?:link skill|skill catalog) dead-code-audit(?: SKILL\.md is not a real regular file| path contains a symlink)|Cursor skill catalog SKILL\.md is not a real regular file: dead-code-audit/,
        );
        assert.strictEqual(
          fs.lstatSync(path.join(bootstrapHome, 'cursor-home'), { throwIfNoEntry: false }),
          undefined,
          `${variant}: bootstrap must fail before creating CURSOR_HOME`,
        );
        assert.deepStrictEqual(snapshotTree(corrupted.external), externalBefore, `${variant}: external changed`);
      } finally {
        corrupted.restore();
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap cria CURSOR_HOME e parents ausentes como diretórios reais', () => {
  const home = freshHome();
  try {
    const ch = path.join(home, 'nested', 'private', 'cursor-home');
    const result = runBootstrap(home, { cursorHome: ch });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    for (const candidate of [
      path.join(home, 'nested'),
      path.join(home, 'nested', 'private'),
      ch,
      path.join(ch, 'skills'),
    ]) {
      const stat = fs.lstatSync(candidate);
      assert.ok(stat.isDirectory(), `${candidate} deve ser diretório`);
      assert.strictEqual(stat.isSymbolicLink(), false, `${candidate} não pode ser symlink`);
    }
    assert.ok(
      fs.realpathSync(path.join(ch, 'skills')).startsWith(`${fs.realpathSync(ch)}${path.sep}`),
      'skills deve ficar fisicamente contido no CURSOR_HOME',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap rejeita skills root symlink antes de qualquer mutação', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    const external = path.join(home, 'external-skills');
    const gstackRoot = path.join(home, 'gstack-source');
    fs.mkdirSync(ch, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'USER_SENTINEL'), 'preserve byte-for-byte\n');
    fs.symlinkSync(external, path.join(ch, 'skills'));
    createGstackFixture(gstackRoot, ['gstack-review']);

    const result = runBootstrap(home, { gstackRoot });
    assert.notStrictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /Cursor root guard failed: Cursor skills root path contains a symlink/);
    assert.deepStrictEqual(fs.readdirSync(ch), ['skills'], 'guard deve rodar antes de hooks/configs');
    assert.deepStrictEqual(fs.readdirSync(external), ['USER_SENTINEL']);
    assert.strictEqual(
      fs.readFileSync(path.join(external, 'USER_SENTINEL'), 'utf8'),
      'preserve byte-for-byte\n',
    );
    for (const name of ['impeccable', 'hm-init', 'gstack-review']) {
      assert.strictEqual(fs.lstatSync(path.join(external, name), { throwIfNoEntry: false }), undefined);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap rejeita CURSOR_HOME ou parent symlink sem escrever no externo', () => {
  for (const variant of ['cursor-home', 'parent']) {
    const home = freshHome();
    try {
      const external = path.join(home, `external-${variant}`);
      fs.mkdirSync(external, { recursive: true });
      let ch;
      if (variant === 'cursor-home') {
        ch = path.join(home, 'cursor-home-link');
        fs.symlinkSync(external, ch);
      } else {
        const parentLink = path.join(home, 'cursor-parent-link');
        fs.symlinkSync(external, parentLink);
        ch = path.join(parentLink, 'cursor-home');
      }

      const result = runBootstrap(home, { cursorHome: ch });
      assert.notStrictEqual(result.code, 0, `${variant}\n${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /Cursor root guard failed: Cursor home path contains a symlink/);
      assert.deepStrictEqual(fs.readdirSync(external), [], `${variant} não pode sofrer mutação`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] bootstrap rejeita intermediário user-controlled 0777 sem mutação', () => {
  const home = freshHome();
  try {
    const unsafeParent = path.join(home, 'unsafe-parent');
    const ch = path.join(unsafeParent, 'nested', 'cursor-home');
    fs.mkdirSync(unsafeParent);
    fs.chmodSync(unsafeParent, 0o777);
    const before = snapshotTree(home);

    const result = runBootstrap(home, { cursorHome: ch });
    assert.notStrictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /Cursor home path component is group\/world-writable/);
    assert.deepStrictEqual(snapshotTree(home), before, 'preflight não pode criar nested/Cursor files');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap aceita intermediários saudáveis 0755/0700 sob HOME', () => {
  const home = freshHome();
  try {
    const first = path.join(home, 'healthy-parent');
    const second = path.join(first, 'private');
    fs.mkdirSync(second, { recursive: true });
    fs.chmodSync(first, 0o755);
    fs.chmodSync(second, 0o700);
    const result = runBootstrap(home, { cursorHome: path.join(second, 'cursor-home') });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] CURSOR_HOME externo aceita prefixo de sistema saudável no macOS/Linux', () => {
  const home = freshHome();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cursor-external-'));
  try {
    fs.chmodSync(external, 0o700);
    const ch = path.join(external, 'private', 'cursor-home');
    const result = runBootstrap(home, { cursorHome: ch });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(fs.lstatSync(path.join(ch, 'skills')).isDirectory());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('[cursor] UID 0 mantém /tmp sticky como ancestral de sistema no Linux', {
  skip: process.platform !== 'linux'
    || typeof process.getuid !== 'function'
    || process.getuid() !== 0,
}, () => {
  const home = fs.mkdtempSync('/tmp/jarvis-root-home-');
  const external = fs.mkdtempSync('/tmp/jarvis-root-cursor-');
  try {
    fs.chmodSync(home, 0o700);
    fs.chmodSync(external, 0o700);
    const ch = path.join(external, 'managed', 'cursor-home');
    const result = runBootstrap(home, { cursorHome: ch });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(fs.lstatSync(path.join(ch, 'skills')).isDirectory());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap rejeita intermediário de outro uid quando executado como root', {
  skip: typeof process.getuid !== 'function' || process.getuid() !== 0,
}, () => {
  const home = freshHome();
  try {
    const foreignParent = path.join(home, 'foreign-parent');
    fs.mkdirSync(foreignParent);
    fs.chownSync(foreignParent, 1, 1);
    const before = snapshotTree(home);
    const result = runBootstrap(home, { cursorHome: path.join(foreignParent, 'cursor-home') });
    assert.notStrictEqual(result.code, 0);
    assert.match(result.stderr, /is not owned by the current user/);
    assert.deepStrictEqual(snapshotTree(home), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] preflight cobre hooks/rules/runtime/configs e modos antes da primeira escrita', () => {
  const variants = [
    {
      name: 'hooks directory symlink',
      arrange(ch, external) { fs.symlinkSync(external, path.join(ch, 'hooks')); },
    },
    {
      name: 'rules directory symlink',
      arrange(ch, external) { fs.symlinkSync(external, path.join(ch, 'rules')); },
    },
    {
      name: 'runtime directory symlink',
      arrange(ch, external) { fs.symlinkSync(external, path.join(ch, 'jarvis-runtime')); },
    },
    {
      name: 'hooks config symlink',
      arrange(ch, external) {
        fs.symlinkSync(path.join(external, 'sentinel.json'), path.join(ch, 'hooks.json'));
      },
    },
    {
      name: 'managed hook file symlink',
      arrange(ch, external) {
        fs.mkdirSync(path.join(ch, 'hooks'));
        fs.symlinkSync(path.join(external, 'sentinel.json'), path.join(ch, 'hooks', 'rtk-shell.js'));
      },
    },
    {
      name: 'group-writable hooks root',
      arrange(ch) {
        fs.mkdirSync(path.join(ch, 'hooks'));
        fs.chmodSync(path.join(ch, 'hooks'), 0o770);
      },
    },
    {
      name: 'world-writable config',
      arrange(ch) {
        fs.writeFileSync(path.join(ch, 'mcp.json'), '{}\n');
        fs.chmodSync(path.join(ch, 'mcp.json'), 0o666);
      },
    },
  ];

  for (const variant of variants) {
    const home = freshHome();
    try {
      const ch = cursorHome(home);
      const external = path.join(home, 'external-target');
      fs.mkdirSync(ch);
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, 'sentinel.json'), '{"preserve":true}\n');
      variant.arrange(ch, external);
      const beforeCursor = snapshotTree(ch);
      const beforeExternal = snapshotTree(external);

      const result = runBootstrap(home);
      assert.notStrictEqual(result.code, 0, `${variant.name}\n${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /Cursor root guard failed:/, variant.name);
      assert.deepStrictEqual(snapshotTree(ch), beforeCursor, `${variant.name}: CURSOR_HOME mutado`);
      assert.deepStrictEqual(snapshotTree(external), beforeExternal, `${variant.name}: externo mutado`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] ensure aceita regular file seguro e o substitui preservando backup', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    const hooks = path.join(ch, 'hooks');
    const target = path.join(hooks, 'rtk-shell.js');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(target, 'user-owned safe regular file\n', { mode: 0o600 });

    const result = runBootstrap(home);
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixed destination must finish as symlink');
    assert.strictEqual(
      fs.realpathSync(target),
      fs.realpathSync(path.join(REPO_ROOT, 'cursor', 'hooks', 'rtk-shell.js')),
    );
    // Backups são parkados FORA da árvore gerenciada: um SKILL.md de backup
    // dentro dela voltaria a ser descoberto como conteúdo real (doctor.sh:448).
    // O slot é um DIRETÓRIO reservado e o parkado fica dentro dele sob o
    // basename original — assim a reserva nunca é desfeita e um backup de
    // diretório não aninha dentro do anterior.
    const backupRoot = path.join(ch, 'backups');
    const backups = (fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [])
      .filter((name) => name.startsWith('rtk-shell.js.backup.'));
    assert.strictEqual(backups.length, 1, `${result.stdout}\n${result.stderr}`);
    assert.strictEqual(
      fs.readFileSync(path.join(backupRoot, backups[0], 'rtk-shell.js'), 'utf8'),
      'user-owned safe regular file\n',
    );
    // E nada de backup sobrou dentro de hooks/.
    assert.deepStrictEqual(
      fs.readdirSync(hooks).filter((name) => name.includes('.backup.')), [],
      'backup não pode ficar dentro da árvore gerenciada');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] preflight cobre destinos dinâmicos e markers do manifesto de skills', () => {
  for (const variant of ['writable-target', 'symlink-marker']) {
    const home = freshHome();
    try {
      const first = runBootstrap(home);
      assert.strictEqual(first.code, 0, `${first.stderr}\n${first.stdout}`);
      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', 'impeccable');
      const external = path.join(home, 'external-marker.json');
      fs.writeFileSync(external, '{"preserve":true}\n');
      if (variant === 'writable-target') {
        fs.chmodSync(target, 0o770);
      } else {
        const marker = path.join(target, '.jarvis-cortex-skill.json');
        fs.unlinkSync(marker);
        fs.symlinkSync(external, marker);
      }
      const beforeCursor = snapshotTree(ch);
      const beforeExternal = fs.readFileSync(external, 'utf8');

      const result = runBootstrap(home);
      assert.notStrictEqual(result.code, 0, `${variant}\n${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /Cursor root guard failed: Cursor managed skill destination impeccable/);
      assert.deepStrictEqual(snapshotTree(ch), beforeCursor, `${variant}: CURSOR_HOME mutado`);
      assert.strictEqual(fs.readFileSync(external, 'utf8'), beforeExternal);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] hook scripts são symlinks que resolvem no cortex', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const hooksDir = path.join(cursorHome(home), 'hooks');
    for (const name of ['rtk-shell.js', 'enforce-cursor.js', 'session-start.js']) {
      const p = path.join(hooksDir, name);
      assert.ok(fs.existsSync(p), `missing ${name}`);
      assert.ok(fs.lstatSync(p).isSymbolicLink(), `${name} should be symlink`);
      const real = fs.realpathSync(p);
      assert.ok(real.includes(`${path.sep}cursor${path.sep}hooks${path.sep}`), real);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] manifesto nativo cobre Cortex, HM e caveman com proveniência exata', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const skills = path.join(cursorHome(home), 'skills');
    for (const name of [
      'dead-code-audit', 'orchestrate', 'security-audit', 'strategic-compact',
      'verification-loop', 'jarvis-cortex', 'jarvis-learn', 'hm-init',
      'cavecrew', 'caveman', 'caveman-review',
    ]) {
      const skillPath = path.join(skills, name);
      assert.ok(fs.existsSync(skillPath), `skill ${name} deve existir em ${skills}`);
      assert.ok(fs.lstatSync(skillPath).isSymbolicLink(), `${name} deve ser symlink`);
      assert.ok(fs.existsSync(path.join(skillPath, 'SKILL.md')), `${name}/SKILL.md deve resolver`);
    }
    const manifest = fs.readFileSync(
      path.join(cursorHome(home), 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    ).trim().split('\n').map((line) => line.split('\t'));
    assert.ok(manifest.length >= 29, `manifesto incompleto: ${manifest.length}`);
    const byName = new Map(manifest.map((fields) => [fields[0], fields]));
    assert.deepStrictEqual(byName.get('impeccable').slice(2), ['cursor-copy', 'cortex']);
    assert.deepStrictEqual(byName.get('hm-init').slice(2), ['link', 'hm']);
    assert.deepStrictEqual(byName.get('caveman').slice(2), ['link', 'caveman']);
    assert.strictEqual(byName.has('learn'), false, 'tombstone não pode entrar no desired manifest');
    for (const [name, source, mode] of manifest) {
      const skillPath = path.join(skills, name);
      if (mode === 'link') assert.strictEqual(fs.realpathSync(skillPath), fs.realpathSync(source));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] skill real do usuário não é sobrescrita nem transformada em backup indexável', () => {
  const home = freshHome();
  try {
    const skills = path.join(cursorHome(home), 'skills');
    const userSkill = path.join(skills, 'hm-init');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '---\nname: hm-init\ndescription: user owned\n---\n');

    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /hm-init exists and is not a Jarvis-managed skill; preserving it/, r.stderr);
    assert.strictEqual(fs.lstatSync(userSkill).isSymbolicLink(), false);
    assert.strictEqual(
      fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8').includes('user owned'),
      true,
    );
    const backups = fs.readdirSync(skills).filter((name) => name.includes('backup'));
    assert.deepStrictEqual(backups, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] symlink do usuário com nome gerenciado é preservado', () => {
  const home = freshHome();
  try {
    const custom = path.join(home, 'custom-hm-init');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: custom-hm-init\ndescription: custom\n---\n');
    const target = path.join(cursorHome(home), 'skills', 'hm-init');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(custom, target);

    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.strictEqual(fs.realpathSync(target), fs.realpathSync(custom));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] link managed aceita só raw target absoluto/relativo canônico exato', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const ch = cursorHome(home);
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const source = fs.readFileSync(manifestPath, 'utf8').split('\n')
      .find((line) => line.startsWith('hm-init\t')).split('\t')[1];
    const target = path.join(ch, 'skills', 'hm-init');
    const alias = path.join(home, 'hm-init-source-alias');
    const parentAlias = path.join(home, 'hm-init-parent-alias');
    fs.symlinkSync(source, alias);
    fs.symlinkSync(path.dirname(source), parentAlias);
    const parent = path.dirname(source);
    const grandparent = path.dirname(parent);
    const invalidTargets = new Map([
      ['alias-component', alias],
      ['alias-plus-dotdot', `${parentAlias}/../${path.basename(parent)}/${path.basename(source)}`],
      ['excessive-dotdot', `${parent}/../${path.basename(parent)}/${path.basename(source)}`],
      ['duplicate-slash', `${parent}//${path.basename(source)}`],
      ['dot-component', `${grandparent}/${path.basename(parent)}/./${path.basename(source)}`],
    ]);
    for (const [label, rawTarget] of invalidTargets) {
      fs.unlinkSync(target);
      fs.symlinkSync(rawTarget, target);
      const before = snapshotTree(target);
      const preserved = runBootstrap(home);
      assert.strictEqual(preserved.code, 0, `${label}: ${preserved.stderr}`);
      assert.match(preserved.stderr, /not a Jarvis-managed symlink; preserving it/, label);
      assert.deepStrictEqual(snapshotTree(target), before, label);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^hm-init\t/m,
        `${label}: target raw não canônico não pode ser reivindicado no manifesto instalado`);
    }

    fs.unlinkSync(target);
    fs.symlinkSync(source, target);
    const accepted = runBootstrap(home);
    assert.strictEqual(accepted.code, 0, accepted.stderr);
    assert.strictEqual(fs.readlinkSync(target), source,
      'target absoluto canônico exato deve permanecer idempotente');
    assert.match(fs.readFileSync(manifestPath, 'utf8'), /^hm-init\t/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] previous link exige source relativo, mode/provenance e checkout físico exatos', () => {
  const cases = [
    {
      label: 'same-mode-wrong-source',
      name: 'hm-init',
      previous(home) {
        return {
          source: path.join(REPO_ROOT, 'codex', 'skills-local', 'hm-deploy'),
          mode: 'link',
          provenance: 'hm',
        };
      },
    },
    {
      label: 'mode-wrong',
      name: 'dead-code-audit',
      previous(home) {
        const oldRoot = path.join(home, 'old-cortex');
        copyCortexFixture(oldRoot);
        return {
          source: path.join(fs.realpathSync(oldRoot), 'active', 'skills', 'dead-code-audit'),
          mode: 'cursor-copy',
          provenance: 'cortex',
        };
      },
    },
    {
      label: 'provenance-wrong',
      name: 'hm-init',
      previous(home) {
        const oldRoot = path.join(home, 'old-cortex');
        copyCortexFixture(oldRoot);
        return {
          source: path.join(fs.realpathSync(oldRoot), 'codex', 'skills-local', 'hm-init'),
          mode: 'link',
          provenance: 'cortex',
        };
      },
    },
    {
      label: 'dangling-previous',
      name: 'hm-init',
      previous(home) {
        return {
          source: path.join(home, 'missing-old-cortex', 'codex', 'skills-local', 'hm-init'),
          mode: 'link',
          provenance: 'hm',
        };
      },
    },
  ];

  for (const variant of cases) {
    const home = freshHome();
    try {
      assert.strictEqual(runBootstrap(home).code, 0, variant.label);
      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', variant.name);
      const state = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const previous = variant.previous(home);
      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(previous.source, target);
      const tampered = fs.readFileSync(state, 'utf8').split('\n').map((line) => {
        const fields = line.split('\t');
        if (fields[0] === variant.name) {
          return [variant.name, previous.source, previous.mode, previous.provenance].join('\t');
        }
        return line;
      }).join('\n');
      fs.writeFileSync(state, tampered);
      const before = snapshotTree(target);

      const first = runBootstrap(home);
      assert.strictEqual(first.code, 0, `${variant.label}\n${first.stderr}\n${first.stdout}`);
      assert.match(first.stderr, /preserving it/, variant.label);
      assert.match(first.stderr, /not a Jarvis-managed symlink; preserving it/, variant.label);
      assert.deepStrictEqual(snapshotTree(target), before, variant.label);
      assert.doesNotMatch(
        fs.readFileSync(state, 'utf8'),
        new RegExp(`^${variant.name}\\t`, 'm'),
        `${variant.label}: collision must be excluded from installed manifest`,
      );

      const second = runBootstrap(home);
      assert.strictEqual(second.code, 0, `${variant.label}/rerun\n${second.stderr}\n${second.stdout}`);
      assert.match(second.stderr, /not a Jarvis-managed symlink; preserving it/, variant.label);
      assert.deepStrictEqual(snapshotTree(target), before, `${variant.label}: rerun must preserve`);
      assert.doesNotMatch(
        fs.readFileSync(state, 'utf8'),
        new RegExp(`^${variant.name}\\t`, 'm'),
        `${variant.label}: rerun must not restore ownership`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'hm-init');
    const state = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const currentSource = fs.readFileSync(state, 'utf8').split('\n')
      .find((line) => line.startsWith('hm-init\t')).split('\t')[1];
    const oldRoot = path.join(home, 'old-cortex');
    copyCortexFixture(oldRoot);
    const oldSource = path.join(fs.realpathSync(oldRoot), 'codex', 'skills-local', 'hm-init');
    fs.unlinkSync(target);
    fs.symlinkSync(oldSource, target);
    const relocated = fs.readFileSync(state, 'utf8').split('\n').map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'hm-init') return ['hm-init', oldSource, 'link', 'hm'].join('\t');
      return line;
    }).join('\n');
    fs.writeFileSync(state, relocated);

    const accepted = runBootstrap(home);
    assert.strictEqual(accepted.code, 0, `${accepted.stderr}\n${accepted.stdout}`);
    assert.strictEqual(fs.readlinkSync(target), currentSource,
      'same catalog-relative source in a valid old checkout should be repointed');
    assert.deepStrictEqual(
      fs.readFileSync(state, 'utf8').split('\n')
        .find((line) => line.startsWith('hm-init\t')).split('\t'),
      ['hm-init', currentSource, 'link', 'hm'],
    );

    const rerun = runBootstrap(home);
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.strictEqual(fs.readlinkSync(target), currentSource);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack instala folhas e wrapper completo fora da árvore indexada', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(
      gstackRoot,
      ['gstack', 'gstack-pair-agent', 'gstack-review', 'gstack-stale'],
    );
    const bootstrapped = runBootstrap(home, { gstackRoot });
    assert.strictEqual(bootstrapped.code, 0, `${bootstrapped.stderr}\n${bootstrapped.stdout}`);
    const skills = path.join(cursorHome(home), 'skills');
    const installedReview = path.join(skills, 'gstack-review');
    assert.strictEqual(fs.lstatSync(installedReview).isSymbolicLink(), false);
    const rendered = fs.readFileSync(path.join(installedReview, 'SKILL.md'), 'utf8');
    assert.match(rendered, /CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack\/source/);
    assert.doesNotMatch(rendered, /\$HOME\/\.cursor\/skills\/gstack/);
    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    const runtimeSource = path.join(runtime, 'source');
    const runtimeState = path.join(cursorHome(home), 'jarvis-runtime', 'gstack-state');
    assert.deepStrictEqual(
      fs.readdirSync(runtime).sort(),
      ['.jarvis-cortex-runtime.json', 'pair-agent', 'source'],
    );
    assert.deepStrictEqual(fs.readdirSync(runtimeState), ['.jarvis-cortex-state.json']);
    assert.strictEqual(fs.statSync(runtimeState).mode & 0o077, 0, 'estado gravável deve ser privado');
    assert.ok(fs.lstatSync(runtimeSource).isSymbolicLink());
    assert.strictEqual(fs.realpathSync(runtimeSource), fs.realpathSync(gstackRoot));
    assert.ok(path.relative(skills, runtime).startsWith('..'), 'runtime deve ficar fora de skills');
    assert.strictEqual(
      fs.lstatSync(path.join(runtime, 'sensitive-canary.fixture'), { throwIfNoEntry: false }),
      undefined,
    );
    assert.strictEqual(
      fs.readFileSync(path.join(runtimeSource, 'sensitive-canary.fixture'), 'utf8'),
      'DO_NOT_COPY_CANARY\n',
    );
    assert.strictEqual(fs.lstatSync(path.join(skills, 'gstack')).isSymbolicLink(), false);
    const functional = spawnSync(path.join(runtimeSource, 'bin', 'gstack-config'), ['get', 'proactive'], {
      encoding: 'utf8',
    });
    assert.strictEqual(functional.status, 0, functional.stderr);
    assert.strictEqual(functional.stdout.trim(), 'true');
    for (const asset of [
      'plan-ceo-review/SKILL.md',
      'plan-devex-review/dx-hall-of-fame.md',
      'lib/diagram-render',
      'lib/redact-audit-log.ts',
      'extension/package.json',
      'browse/dist/browse',
    ]) {
      const throughWrapper = path.join(runtimeSource, asset);
      assert.ok(fs.existsSync(throughWrapper), `runtime completo deve resolver ${asset}`);
      assert.strictEqual(fs.realpathSync(throughWrapper), fs.realpathSync(path.join(gstackRoot, asset)));
    }

    const renderedPair = fs.readFileSync(
      path.join(skills, 'gstack-pair-agent', 'SKILL.md'),
      'utf8',
    );
    assert.match(
      renderedPair,
      /jarvis-runtime\/gstack-state\/cursor-home\/\.cursor\/skills\/gstack\/browse-remote\.json/,
    );
    assert.match(renderedPair, /jarvis-runtime\/gstack-state\/\.feature-prompted-continuous-checkpoint/);
    assert.match(renderedPair, /jarvis-runtime\/gstack-state\/\.feature-prompted-model-overlay/);
    assert.match(renderedPair, /jarvis-runtime\/gstack\/pair-agent" pair-agent --local TARGET_HOST/);
    assert.doesNotMatch(renderedPair, /jarvis-runtime\/gstack\/source\/browse-remote\.json/);
    assert.doesNotMatch(renderedPair, /jarvis-runtime\/gstack\/source\/\.feature-prompted-/);

    const launcherEnv = { ...process.env };
    launcherEnv.HOME = home;
    const pairLauncher = path.join(runtime, 'pair-agent');
    const cursorPair = spawnSync(pairLauncher, ['pair-agent', '--local', 'cursor'], {
      encoding: 'utf8',
      env: launcherEnv,
    });
    assert.strictEqual(cursorPair.status, 0, cursorPair.stderr);
    const privateCursorConfig = path.join(
      runtimeState,
      'cursor-home',
      '.cursor',
      'skills',
      'gstack',
      'browse-remote.json',
    );
    assert.strictEqual(fs.readFileSync(privateCursorConfig, 'utf8'), '{"fixture":"local-only"}\n');
    assert.strictEqual(
      fs.lstatSync(
        path.join(home, '.cursor', 'skills', 'gstack', 'browse-remote.json'),
        { throwIfNoEntry: false },
      ),
      undefined,
    );

    const codexPair = spawnSync(pairLauncher, ['pair-agent', '--local', 'codex'], {
      encoding: 'utf8',
      env: launcherEnv,
    });
    assert.strictEqual(codexPair.status, 0, codexPair.stderr);
    assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'gstack', 'browse-remote.json')));
    assert.strictEqual(
      fs.lstatSync(
        path.join(runtimeState, 'cursor-home', '.codex', 'skills', 'gstack', 'browse-remote.json'),
        { throwIfNoEntry: false },
      ),
      undefined,
    );

    fs.writeFileSync(path.join(runtimeState, '.feature-prompted-continuous-checkpoint'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(runtimeState, '.feature-prompted-model-overlay'), '', { mode: 0o600 });
    assert.strictEqual(
      fs.lstatSync(path.join(gstackRoot, 'browse-remote.json'), { throwIfNoEntry: false }),
      undefined,
    );
    assert.strictEqual(
      fs.lstatSync(path.join(gstackRoot, '.feature-prompted-continuous-checkpoint'), { throwIfNoEntry: false }),
      undefined,
    );
    assert.strictEqual(
      fs.lstatSync(path.join(gstackRoot, '.feature-prompted-model-overlay'), { throwIfNoEntry: false }),
      undefined,
    );

    const auditRun = spawnSync(process.execPath, [CURSOR_AUDIT_TOOL, skills], { encoding: 'utf8' });
    assert.strictEqual(auditRun.status, 0, auditRun.stderr);
    const audit = JSON.parse(auditRun.stdout);
    assert.strictEqual(audit.skills.some((skill) => skill.name === 'plan-ceo-review-runtime'), false);
    assert.strictEqual(audit.skills.some((skill) => skill.path.includes('jarvis-runtime')), false);
    const canonicalGstackRoot = fs.realpathSync(gstackRoot);

    const verify = () => spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', canonicalGstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.strictEqual(verify().status, 0);
    fs.writeFileSync(path.join(runtime, 'unexpected-copy.txt'), 'must fail\n');
    const unexpected = verify();
    assert.notStrictEqual(unexpected.status, 0);
    assert.match(unexpected.stderr, /unexpected gstack runtime wrapper entries/);
    fs.rmSync(path.join(runtime, 'unexpected-copy.txt'));

    const wrongSource = path.join(home, 'wrong-gstack-source');
    fs.mkdirSync(wrongSource);
    fs.unlinkSync(runtimeSource);
    fs.symlinkSync(wrongSource, runtimeSource);
    const wrongProvenance = verify();
    assert.notStrictEqual(wrongProvenance.status, 0);
    assert.match(wrongProvenance.stderr, /source provenance mismatch/);
    fs.unlinkSync(runtimeSource);
    fs.symlinkSync(canonicalGstackRoot, runtimeSource);

    const insideSkills = path.join(skills, 'runtime-wrapper');
    const misplaced = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-sync', gstackRoot, insideSkills, skills,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(misplaced.status, 0);
    assert.match(misplaced.stderr, /must be outside the Cursor skills tree/);
    assert.strictEqual(fs.lstatSync(insideSkills, { throwIfNoEntry: false }), undefined);

    fs.rmSync(path.join(generated, 'gstack-stale'), { recursive: true, force: true });
    fs.symlinkSync(path.join(generated, 'gstack-obsolete'), path.join(skills, 'gstack-obsolete'));
    const custom = path.join(home, 'custom-gstack-skill');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: custom-gstack\ndescription: custom\n---\n');
    fs.symlinkSync(custom, path.join(skills, 'gstack-personal'));

    const rerun = runBootstrap(home, { gstackRoot });
    assert.strictEqual(rerun.code, 0, rerun.stderr);
    assert.deepStrictEqual(
      fs.readdirSync(runtime).sort(),
      ['.jarvis-cortex-runtime.json', 'pair-agent', 'source'],
    );
    assert.strictEqual(fs.realpathSync(runtimeSource), fs.realpathSync(gstackRoot));
    assert.strictEqual(
      fs.readFileSync(path.join(runtimeSource, 'sensitive-canary.fixture'), 'utf8'),
      'DO_NOT_COPY_CANARY\n',
    );
    assert.strictEqual(
      fs.readFileSync(
        path.join(runtimeState, 'cursor-home', '.cursor', 'skills', 'gstack', 'browse-remote.json'),
        'utf8',
      ),
      '{"fixture":"local-only"}\n',
    );
    assert.ok(fs.lstatSync(path.join(skills, 'gstack-stale')).isDirectory(),
      'removed/unverifiable generated source cannot authorize deleting the installed copy');
    assert.match(rerun.stderr, /stale Cursor gstack copy .*gstack-stale.*preserving it/);
    assert.ok(fs.lstatSync(path.join(skills, 'gstack-obsolete')).isSymbolicLink(),
      'unregistered link after manifest install is user-owned and must be preserved');
    assert.strictEqual(fs.realpathSync(path.join(skills, 'gstack-personal')), fs.realpathSync(custom));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack-copy full tuple preserva cross-source, stale arbitrário e marker/manifest divergentes', () => {
  const variants = ['cross-source', 'arbitrary-stale', 'wrong-marker', 'wrong-tuple'];
  for (const variant of variants) {
    const home = freshHome();
    try {
      const gstackRoot = path.join(home, 'gstack-source');
      const generated = createGstackFixture(gstackRoot, ['gstack-review', 'gstack-browse']);
      const installed = runBootstrap(home, { gstackRoot });
      assert.strictEqual(installed.code, 0, `${variant}\n${installed.stderr}\n${installed.stdout}`);
      const ch = cursorHome(home);
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const reviewTarget = path.join(ch, 'skills', 'gstack-review');
      let target = reviewTarget;
      let rowName = 'gstack-review';

      if (variant === 'cross-source') {
        const browseSource = fs.realpathSync(path.join(generated, 'gstack-browse'));
        const markerPath = path.join(target, '.jarvis-cortex-skill.json');
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        marker.sourcePath = browseSource;
        marker.sourceReal = browseSource;
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
        const changed = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
          const fields = line.split('\t');
          if (fields[0] === rowName) fields[1] = browseSource;
          return fields.join('\t');
        }).join('\n');
        fs.writeFileSync(manifestPath, changed);
      } else if (variant === 'arbitrary-stale') {
        rowName = 'gstack-arbitrary';
        target = path.join(ch, 'skills', rowName);
        fs.cpSync(reviewTarget, target, { recursive: true });
        const source = fs.realpathSync(path.join(generated, 'gstack-review'));
        fs.appendFileSync(manifestPath, `${rowName}\t${source}\tgstack-copy\tgstack\n`);
      } else if (variant === 'wrong-marker') {
        const markerPath = path.join(target, '.jarvis-cortex-skill.json');
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        marker.name = 'gstack-browse';
        marker.provenance = 'cortex';
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
      } else {
        const changed = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
          const fields = line.split('\t');
          if (fields[0] === rowName) return [rowName, fields[1], 'link', 'cortex'].join('\t');
          return line;
        }).join('\n');
        fs.writeFileSync(manifestPath, changed);
      }
      fs.appendFileSync(path.join(target, 'SKILL.md'), `\nPRESERVE_${variant}\n`);
      const before = snapshotTree(target);

      const first = runBootstrap(home, { gstackRoot });
      assert.strictEqual(first.code, 0, `${variant}\n${first.stderr}\n${first.stdout}`);
      assert.deepStrictEqual(snapshotTree(target), before, variant);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), new RegExp(`^${rowName}\\t`, 'm'));

      const second = runBootstrap(home, { gstackRoot });
      assert.strictEqual(second.code, 0, `${variant}/rerun\n${second.stderr}\n${second.stdout}`);
      assert.deepStrictEqual(snapshotTree(target), before, `${variant}: rerun`);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), new RegExp(`^${rowName}\\t`, 'm'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] orphan mapped rejeita root/source diferente e cross-name sem reapropriar target', () => {
  for (const variant of ['different-root', 'cross-name']) {
    const home = freshHome();
    try {
      const gstackRoot = path.join(home, 'gstack-source');
      const generated = createGstackFixture(gstackRoot, [
        { name: 'review', sourceLeaf: 'gstack-review' },
        { name: 'browse', sourceLeaf: 'gstack-browse' },
      ]);
      assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0, variant);
      const ch = cursorHome(home);
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const target = path.join(ch, 'skills', 'review');
      const source = path.join(generated, 'gstack-review');
      const saved = path.join(home, 'saved-gstack-review');
      const before = snapshotTree(target);
      const injectedSource = variant === 'different-root'
        ? path.join(home, 'other-gstack', '.cursor', 'skills', 'gstack-review')
        : fs.realpathSync(path.join(generated, 'gstack-browse'));
      const injected = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
        const fields = line.split('\t');
        if (fields[0] === 'review') fields[1] = injectedSource;
        return fields.join('\t');
      }).join('\n');
      fs.writeFileSync(manifestPath, injected);
      fs.renameSync(source, saved);

      const unavailable = runBootstrap(home, { gstackRoot });
      assert.strictEqual(unavailable.code, 0, `${variant}\n${unavailable.stderr}`);
      assert.deepStrictEqual(snapshotTree(target), before, `${variant}: unavailable source`);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^review\t/m,
        `${variant}: injected historical source must not remain authoritative`);

      fs.renameSync(saved, source);
      const restored = runBootstrap(home, { gstackRoot });
      assert.strictEqual(restored.code, 0, `${variant}/restore\n${restored.stderr}`);
      assert.match(restored.stderr,
        /review.*not backed by the exact installed gstack-copy tuple|review.*preserving it/,
        restored.stderr);
      assert.deepStrictEqual(snapshotTree(target), before, `${variant}: restored source`);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^review\t/m,
        `${variant}: restored source cannot revive an untrusted tuple`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] cursor-copy full tuple preserva source, marker e manifesto divergentes', () => {
  for (const variant of ['wrong-source', 'wrong-marker', 'wrong-tuple']) {
    const home = freshHome();
    try {
      assert.strictEqual(runBootstrap(home).code, 0, variant);
      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', 'impeccable');
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const markerPath = path.join(target, '.jarvis-cortex-skill.json');
      if (variant === 'wrong-source') {
        const oldCortex = path.join(home, 'old-cortex');
        copyCortexFixture(oldCortex);
        const wrongSource = path.join(
          fs.realpathSync(oldCortex), 'active', 'skills', 'dead-code-audit',
        );
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        marker.sourcePath = wrongSource;
        marker.sourceReal = wrongSource;
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
        const changed = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
          const fields = line.split('\t');
          if (fields[0] === 'impeccable') fields[1] = wrongSource;
          return fields.join('\t');
        }).join('\n');
        fs.writeFileSync(manifestPath, changed);
      } else if (variant === 'wrong-marker') {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        marker.name = 'dead-code-audit';
        marker.provenance = 'hm';
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
      } else {
        const changed = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
          const fields = line.split('\t');
          if (fields[0] === 'impeccable') return ['impeccable', fields[1], 'link', 'cortex'].join('\t');
          return line;
        }).join('\n');
        fs.writeFileSync(manifestPath, changed);
      }
      fs.appendFileSync(path.join(target, 'SKILL.md'), `\nPRESERVE_${variant}\n`);
      const before = snapshotTree(target);

      for (const phase of ['first', 'rerun']) {
        const result = runBootstrap(home);
        assert.strictEqual(result.code, 0, `${variant}/${phase}\n${result.stderr}\n${result.stdout}`);
        assert.deepStrictEqual(snapshotTree(target), before, `${variant}/${phase}`);
        assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^impeccable\t/m);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] catálogo falha atomicamente quando source Cortex declara outro nome', () => {
  for (const name of ['hm-init', 'impeccable']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const relative = name === 'hm-init'
        ? ['codex', 'skills-local', name]
        : ['active', 'skills', name];
      const skillFile = path.join(repoRoot, ...relative, 'SKILL.md');
      const original = fs.readFileSync(skillFile, 'utf8');
      fs.writeFileSync(skillFile, original.replace(
        new RegExp(`^name: ${name}$`, 'm'),
        `name: ${name}-renamed`,
      ));
      const generated = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts', 'cursor-skill-manifest.mjs'),
        repoRoot,
        path.join(home, 'missing-gstack'),
      ], { encoding: 'utf8' });
      assert.notStrictEqual(generated.status, 0, name);
      assert.strictEqual(generated.stdout, '', `${name}: manifest output must be atomic`);
      assert.match(generated.stderr, /frontmatter name mismatch/, name);

      const bootstrapped = runBootstrap(home, {
        script: path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh'),
      });
      assert.notStrictEqual(bootstrapped.code, 0, name);
      assert.match(bootstrapped.stderr, /frontmatter name mismatch/, name);
      assert.strictEqual(
        fs.lstatSync(cursorHome(home), { throwIfNoEntry: false }),
        undefined,
        `${name}: identity failure must precede CURSOR_HOME mutation`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] gstack/cursor-copy rejeitam source com frontmatter diferente do target', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-review']);
    const gstackSource = path.join(generated, 'gstack-review');
    fs.writeFileSync(
      path.join(gstackSource, 'SKILL.md'),
      fs.readFileSync(path.join(gstackSource, 'SKILL.md'), 'utf8')
        .replace(/^name: gstack-review$/m, 'name: gstack-review-renamed'),
    );
    const parsed = spawnSync(process.execPath, [
      GSTACK_TOOL, 'skill-parse-verify', gstackSource, 'gstack-review',
    ], { encoding: 'utf8' });
    assert.notStrictEqual(parsed.status, 0, parsed.stderr);
    assert.match(parsed.stderr, /frontmatter name mismatch/);

    const oldCortex = path.join(home, 'old-cortex');
    copyCortexFixture(oldCortex);
    const copySource = path.join(fs.realpathSync(oldCortex), 'active', 'skills', 'impeccable');
    const copySkill = path.join(copySource, 'SKILL.md');
    fs.writeFileSync(
      copySkill,
      fs.readFileSync(copySkill, 'utf8').replace(/^name: impeccable$/m, 'name: impeccable-renamed'),
    );
    const copyTarget = path.join(home, 'copy-target', 'impeccable');
    const copied = spawnSync(process.execPath, [
      CURSOR_COPY_TOOL, 'sync', copySource, copyTarget,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(copied.status, 0, copied.stderr);
    assert.match(copied.stderr, /frontmatter name mismatch/);
    assert.strictEqual(fs.lstatSync(copyTarget, { throwIfNoEntry: false }), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] scan do catálogo real emite somente rows com frontmatter imediato idêntico', {
  skip: !HAVE_REAL_GSTACK && REAL_GSTACK_SKIP,
}, () => {
  const assertGstackIntact = realGstackGuard();
  const generated = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'cursor-skill-manifest.mjs'),
    REPO_ROOT,
    REAL_GSTACK_ROOT,
  ], { encoding: 'utf8' });
  assert.strictEqual(generated.status, 0, generated.stderr);
  const rows = generated.stdout.trimEnd().split('\n').map((line) => line.split('\t'));
  assert.ok(rows.length > 20);
  for (const [name, source] of rows) {
    const immediate = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
    const declared = immediate.match(/^name: ([A-Za-z0-9._#-]+)$/m)?.[1];
    assert.strictEqual(declared, name, source);
  }
  assertGstackIntact();
});

test('[cursor] gstack-copy migra symlink gerado somente quando não existe manifesto anterior', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'gstack-review');
    const source = path.join(gstackRoot, '.cursor', 'skills', 'gstack-review');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
    assert.strictEqual(
      fs.lstatSync(path.join(ch, 'jarvis-cortex-skills.manifest.tsv'), { throwIfNoEntry: false }),
      undefined,
    );

    const migrated = runBootstrap(home, { gstackRoot });
    assert.strictEqual(migrated.code, 0, `${migrated.stderr}\n${migrated.stdout}`);
    assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), false);
    assert.ok(fs.existsSync(path.join(target, '.jarvis-cortex-skill.json')));
    assert.match(
      fs.readFileSync(path.join(ch, 'jarvis-cortex-skills.manifest.tsv'), 'utf8'),
      /^gstack-review\t.*\tgstack-copy\tgstack$/m,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] aliases gbrain extensionless renderizam e validam os executáveis Bun reais', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-setup-gbrain']);
    const sourceSkill = path.join(generated, 'gstack-setup-gbrain', 'SKILL.md');
    fs.appendFileSync(sourceSkill, [
      '```bash',
      '~/.cursor/skills/gstack/bin/gstack-memory-ingest --probe',
      '~/.cursor/skills/gstack/bin/gstack-gbrain-sync --full --no-brain-sync',
      '$GSTACK_BIN/gstack-memory-ingest --probe',
      'bun run ~/.cursor/skills/gstack/bin/gstack-gbrain-sync.ts <user-args>',
      '```',
      '',
    ].join('\n'));
    for (const script of ['gstack-memory-ingest.ts', 'gstack-gbrain-sync.ts']) {
      fs.writeFileSync(path.join(gstackRoot, 'bin', script), '#!/usr/bin/env bun\nprocess.exit(0);\n');
      fs.chmodSync(path.join(gstackRoot, 'bin', script), 0o644);
    }

    const installed = runBootstrap(home, { gstackRoot });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    const rendered = fs.readFileSync(
      path.join(cursorHome(home), 'skills', 'gstack-setup-gbrain', 'SKILL.md'),
      'utf8',
    );
    assert.match(rendered, /bun run "\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack\/source\/bin\/gstack-memory-ingest\.ts" --probe/);
    assert.match(rendered, /bun run "\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack\/source\/bin\/gstack-gbrain-sync\.ts" --full --no-brain-sync/);
    assert.match(rendered, /bun run "\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack\/source\/bin\/gstack-gbrain-sync\.ts" <user-args>/);
    assert.doesNotMatch(rendered, /\.ts\.ts/);
    assert.doesNotMatch(rendered, /bin\/gstack-(?:memory-ingest|gbrain-sync) (?:--probe|--full)/);
    assert.doesNotMatch(rendered, /\$\{?GSTACK_BIN\}?\/gstack-(?:memory-ingest|gbrain-sync)/);

    const renderedCommand = 'bun run "${CURSOR_HOME:-$HOME/.cursor}/jarvis-runtime/gstack/source/bin/gstack-memory-ingest.ts" --probe';
    assert.ok(rendered.split('\n').includes(renderedCommand));
    const captureBin = path.join(home, 'capture-bin');
    const captureFile = path.join(home, 'bun-argv.json');
    const spacedCursorHome = path.join(home, 'Cursor Home With Spaces');
    fs.mkdirSync(captureBin);
    fs.writeFileSync(path.join(captureBin, 'bun'), [
      '#!/usr/bin/env node',
      "const environment = process.env;",
      "require('node:fs').writeFileSync(environment.BUN_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      '',
    ].join('\n'));
    fs.chmodSync(path.join(captureBin, 'bun'), 0o755);
    const executed = spawnSync('bash', ['-c', renderedCommand], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CURSOR_HOME: spacedCursorHome,
        BUN_ARGV_CAPTURE: captureFile,
        PATH: `${captureBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.strictEqual(executed.status, 0, executed.stderr);
    const bunArgv = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.deepStrictEqual(bunArgv, [
      'run',
      path.join(spacedCursorHome, 'jarvis-runtime', 'gstack', 'source', 'bin', 'gstack-memory-ingest.ts'),
      '--probe',
    ]);

    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    const skills = path.join(cursorHome(home), 'skills');
    const canonicalGstackRoot = fs.realpathSync(gstackRoot);
    const verify = () => spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', canonicalGstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.strictEqual(verify().status, 0);

    const syncScript = path.join(gstackRoot, 'bin', 'gstack-gbrain-sync.ts');
    fs.writeFileSync(syncScript, '#!/usr/bin/env node\nprocess.exit(0);\n');
    const badShebang = verify();
    assert.notStrictEqual(badShebang.status, 0);
    assert.match(badShebang.stderr, /Bun runtime asset has an unexpected shebang/);

    const external = path.join(home, 'external-gbrain-sync.ts');
    fs.writeFileSync(external, '#!/usr/bin/env bun\nprocess.exit(0);\n');
    const beforeExternal = fs.readFileSync(external, 'utf8');
    fs.unlinkSync(syncScript);
    fs.symlinkSync(external, syncScript);
    const symlinked = verify();
    assert.notStrictEqual(symlinked.status, 0);
    assert.match(symlinked.stderr, /runtime asset is a symlink/);
    assert.strictEqual(fs.readFileSync(external, 'utf8'), beforeExternal);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] inventário de launchers preserva argv/redirection/status com CURSOR_HOME hostil', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-command-safety']);
    const sourceSkill = path.join(generated, 'gstack-command-safety', 'SKILL.md');
    fs.mkdirSync(path.join(gstackRoot, 'make-pdf', 'dist'), { recursive: true });
    const captureProgram = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const environment = process.env;",
      'fs.appendFileSync(environment.GSTACK_ARGV_CAPTURE, `${JSON.stringify({',
      '  executable: path.basename(process.argv[1]),',
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '})}\\n`);',
      "process.exit(process.argv[2] === 'status-7' ? 7 : 0);",
      '',
    ].join('\n');
    for (const executable of [
      path.join(gstackRoot, 'bin', 'gstack-config'),
      path.join(gstackRoot, 'browse', 'dist', 'browse'),
      path.join(gstackRoot, 'browse', 'bin', 'remote-slug'),
      path.join(gstackRoot, 'design', 'dist', 'design'),
      path.join(gstackRoot, 'make-pdf', 'dist', 'pdf'),
    ]) {
      fs.writeFileSync(executable, captureProgram);
      fs.chmodSync(executable, 0o755);
    }
    for (const script of [
      path.join(gstackRoot, 'design-html', 'vendor', 'pretext.js'),
      path.join(gstackRoot, 'lib', 'redact-audit-log.ts'),
    ]) fs.writeFileSync(script, captureProgram);
    fs.writeFileSync(path.join(gstackRoot, 'review', 'checklist.md'), 'CHECKLIST_CONTENT\n');
    fs.writeFileSync(sourceSkill, [
      '---',
      'name: gstack-command-safety',
      'description: command rendering fixture',
      '---',
      '```bash',
      '# BEHAVIOR_START',
      'GSTACK_ROOT="$HOME/.cursor/skills/gstack"',
      'GSTACK_BIN="$GSTACK_ROOT/bin"',
      'GSTACK_BROWSE="$GSTACK_ROOT/browse/dist"',
      'GSTACK_DESIGN="$GSTACK_ROOT/design/dist"',
      'GSTACK_MAKE_PDF="$GSTACK_ROOT/make-pdf/dist"',
      'B=""',
      '[ -z "$B" ] && B="$HOME$GSTACK_BROWSE/browse"',
      'D=""',
      '[ -z "$D" ] && D="$HOME$GSTACK_DESIGN/design"',
      'P=""',
      '[ -z "$P" ] && P="$HOME$GSTACK_MAKE_PDF/pdf"',
      '$GSTACK_BIN/gstack-config preamble "two words"',
      '${GSTACK_BIN}/gstack-config braced "brace words"',
      '$GSTACK_BROWSE/browse direct-browse "browse words"',
      '${GSTACK_DESIGN}/design direct-design "design direct words"',
      '$GSTACK_MAKE_PDF/pdf direct-pdf "pdf direct words"',
      '$HOME/.cursor/skills/gstack/bin/gstack-config legacy-home "legacy words"',
      '$B snapshot --label "two words"',
      '$D variants --brief "design words"',
      '${P} generate "input file.md" "output file.pdf"',
      '$B pair-agent --local cursor',
      '$B pair-agent --client "TARGET HOST"',
      '${B} pair-agent --admin --client "ADMIN HOST"',
      '$GSTACK_BIN/gstack-config redirect "redirect words" > "$REDIRECT_OUT"',
      'SUBCOMMAND_OUTPUT=$($GSTACK_BIN/gstack-config subcommand "sub words")',
      'CHECKLIST=$GSTACK_ROOT/review/checklist.md',
      'cat $GSTACK_ROOT/review/checklist.md > "$CAT_OUT"',
      'node $GSTACK_ROOT/design-html/vendor/pretext.js node-path "node words"',
      'REMOTE_RESULT=$($GSTACK_ROOT/browse/bin/remote-slug remote "slug words")',
      'node $GSTACK_ROOT/lib/redact-audit-log.ts redact "redact words"',
      'wc -c < $GSTACK_ROOT/review/checklist.md > "$COUNT_OUT"',
      'ALREADY="$GSTACK_ROOT/review/checklist.md"',
      'echo "READY: $B" > "$READY_OUT"',
      '$GSTACK_BIN/gstack-config status-7',
      '# BEHAVIOR_END',
      '```',
      'Inline command: `cat $GSTACK_ROOT/review/checklist.md`.',
      'Prose path stays `$GSTACK_ROOT/review/checklist.md`.',
      '',
    ].join('\n'));

    const hostileCursorHome = path.join(home, 'Cursor Home With Spaces\nAnd Newline');
    const installed = runBootstrap(home, { gstackRoot, cursorHome: hostileCursorHome });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    const rendered = fs.readFileSync(
      path.join(hostileCursorHome, 'skills', 'gstack-command-safety', 'SKILL.md'),
      'utf8',
    );
    const behavior = rendered.split('# BEHAVIOR_START\n')[1].split('\n# BEHAVIOR_END')[0];
    assert.match(rendered, /"\$GSTACK_BIN\/gstack-config" preamble "two words"/);
    assert.match(rendered, /"\$\{GSTACK_BIN\}\/gstack-config" braced "brace words"/);
    assert.match(rendered, /"\$GSTACK_BROWSE\/browse" direct-browse "browse words"/);
    assert.match(rendered, /"\$\{GSTACK_DESIGN\}\/design" direct-design "design direct words"/);
    assert.match(rendered, /"\$GSTACK_MAKE_PDF\/pdf" direct-pdf "pdf direct words"/);
    assert.match(rendered, /"\$\{CURSOR_HOME:-\$HOME\/\.cursor\}\/jarvis-runtime\/gstack\/source\/bin\/gstack-config" legacy-home/);
    assert.match(rendered, /"\$B" snapshot --label "two words"/);
    assert.match(rendered, /"\$D" variants --brief "design words"/);
    assert.match(rendered, /"\$\{P\}" generate "input file\.md" "output file\.pdf"/);
    assert.match(rendered, /CHECKLIST="\$GSTACK_ROOT\/review\/checklist\.md"/);
    assert.match(rendered, /cat "\$GSTACK_ROOT\/review\/checklist\.md" > "\$CAT_OUT"/);
    assert.match(rendered, /node "\$GSTACK_ROOT\/design-html\/vendor\/pretext\.js" node-path/);
    assert.match(rendered, /REMOTE_RESULT=\$\("\$GSTACK_ROOT\/browse\/bin\/remote-slug" remote/);
    assert.match(rendered, /node "\$GSTACK_ROOT\/lib\/redact-audit-log\.ts" redact/);
    assert.match(rendered, /wc -c < "\$GSTACK_ROOT\/review\/checklist\.md"/);
    assert.match(rendered, /ALREADY="\$GSTACK_ROOT\/review\/checklist\.md"/);
    assert.match(rendered, /echo "READY: \$B" > "\$READY_OUT"/);
    assert.match(rendered, /Inline command: `cat "\$GSTACK_ROOT\/review\/checklist\.md"`\./);
    assert.match(rendered, /Prose path stays `\$GSTACK_ROOT\/review\/checklist\.md`\./);
    assert.match(rendered, /jarvis-runtime\/gstack\/pair-agent" pair-agent --local cursor/);
    assert.match(rendered, /jarvis-runtime\/gstack\/pair-agent" pair-agent --client "TARGET HOST"/);
    assert.match(rendered, /jarvis-runtime\/gstack\/pair-agent" pair-agent --admin --client "ADMIN HOST"/);
    assert.doesNotMatch(rendered, /""\$(?:GSTACK_BIN|B|D|P)|""\$\{CURSOR_HOME/);
    assert.deepStrictEqual(
      unsafeRuntimeReferencesInMarkdown(rendered, 'gstack-command-safety'),
      [],
      'nenhum path runtime em contexto shell pode permanecer sem quoting',
    );

    const captureFile = path.join(home, 'captured-argv.jsonl');
    const redirectFile = path.join(home, 'redirect output.txt');
    const catFile = path.join(home, 'cat output.txt');
    const countFile = path.join(home, 'count output.txt');
    const readyFile = path.join(home, 'ready output.txt');
    const behaviorCwd = path.join(home, 'Working Directory With Spaces\nAnd Newline');
    fs.mkdirSync(behaviorCwd);
    const executed = spawnSync('bash', ['-c', behavior], {
      encoding: 'utf8',
      cwd: behaviorCwd,
      env: {
        ...process.env,
        CURSOR_HOME: hostileCursorHome,
        GSTACK_ARGV_CAPTURE: captureFile,
        REDIRECT_OUT: redirectFile,
        CAT_OUT: catFile,
        COUNT_OUT: countFile,
        READY_OUT: readyFile,
      },
    });
    assert.strictEqual(executed.status, 7, `${executed.stderr}\n${executed.stdout}`);
    assert.strictEqual(executed.stderr, '', executed.stderr);
    const captured = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map(JSON.parse);
    const expectedCwd = fs.realpathSync(behaviorCwd);
    assert.deepStrictEqual(captured, [
      { executable: 'gstack-config', argv: ['preamble', 'two words'], cwd: expectedCwd },
      { executable: 'gstack-config', argv: ['braced', 'brace words'], cwd: expectedCwd },
      { executable: 'browse', argv: ['direct-browse', 'browse words'], cwd: expectedCwd },
      { executable: 'design', argv: ['direct-design', 'design direct words'], cwd: expectedCwd },
      { executable: 'pdf', argv: ['direct-pdf', 'pdf direct words'], cwd: expectedCwd },
      { executable: 'gstack-config', argv: ['legacy-home', 'legacy words'], cwd: expectedCwd },
      { executable: 'browse', argv: ['snapshot', '--label', 'two words'], cwd: expectedCwd },
      { executable: 'design', argv: ['variants', '--brief', 'design words'], cwd: expectedCwd },
      { executable: 'pdf', argv: ['generate', 'input file.md', 'output file.pdf'], cwd: expectedCwd },
      { executable: 'browse', argv: ['pair-agent', '--local', 'cursor'], cwd: expectedCwd },
      { executable: 'browse', argv: ['pair-agent', '--client', 'TARGET HOST'], cwd: expectedCwd },
      { executable: 'browse', argv: ['pair-agent', '--admin', '--client', 'ADMIN HOST'], cwd: expectedCwd },
      { executable: 'gstack-config', argv: ['redirect', 'redirect words'], cwd: expectedCwd },
      { executable: 'gstack-config', argv: ['subcommand', 'sub words'], cwd: expectedCwd },
      { executable: 'pretext.js', argv: ['node-path', 'node words'], cwd: expectedCwd },
      { executable: 'remote-slug', argv: ['remote', 'slug words'], cwd: expectedCwd },
      { executable: 'redact-audit-log.ts', argv: ['redact', 'redact words'], cwd: expectedCwd },
      { executable: 'gstack-config', argv: ['status-7'], cwd: expectedCwd },
    ]);
    assert.ok(fs.existsSync(redirectFile), 'redirection deve ser interpretada pelo shell');
    assert.strictEqual(fs.readFileSync(catFile, 'utf8'), 'CHECKLIST_CONTENT\n');
    assert.strictEqual(Number.parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10), 18);
    assert.strictEqual(
      fs.readFileSync(readyFile, 'utf8'),
      `READY: ${path.join(hostileCursorHome, 'jarvis-runtime', 'gstack', 'source', 'browse', 'dist', 'browse')}\n`,
    );

    const secondRoot = path.join(home, 'second-gstack-source');
    fs.cpSync(gstackRoot, secondRoot, { recursive: true });
    const secondSource = path.join(secondRoot, '.cursor', 'skills', 'gstack-command-safety');
    fs.writeFileSync(path.join(secondSource, 'SKILL.md'), rendered);
    const secondTarget = path.join(home, 'second-render', 'gstack-command-safety');
    const rerendered = spawnSync(process.execPath, [
      GSTACK_TOOL, 'skill-sync', secondSource, secondTarget,
    ], { encoding: 'utf8' });
    assert.strictEqual(rerendered.status, 0, rerendered.stderr);
    assert.strictEqual(fs.readFileSync(path.join(secondTarget, 'SKILL.md'), 'utf8'), rendered,
      'renderMarkdown deve ser idempotente');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] fences CommonMark e heredocs preservam fronteiras, bytes e idempotência', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-heredoc-safety']);
    const source = path.join(generated, 'gstack-heredoc-safety');
    const sourceFile = path.join(source, 'SKILL.md');
    fs.writeFileSync(sourceFile, [
      '---',
      'name: gstack-heredoc-safety',
      'description: CommonMark and heredoc fixture',
      '---',
      '~~~bash shell-example',
      '$GSTACK_BIN/gstack-config before',
      'VALUE=$((4 << 1))',
      '(( VALUE = 8 << 1 ))',
      'cat <<\'FIRST\' 3<<- "SECOND"',
      '$HOME/.cursor/skills/gstack/bin/gstack-config',
      '"$GSTACK_BIN/gstack-config"',
      'FIRST',
      '\t${HOME}/.cursor/skills/gstack/lib/redact-audit-log.ts',
      '\tSECOND',
      'cat <<\\THIRD',
      '~/.cursor/skills/gstack/review/checklist.md',
      'THIRD',
      '$GSTACK_BIN/gstack-config after',
      '~~~~',
      'Later prose $GSTACK_BIN/gstack-config must remain prose.',
      '',
    ].join('\n'));

    const target = path.join(home, 'rendered', 'gstack-heredoc-safety');
    const first = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', source, target], {
      encoding: 'utf8',
    });
    assert.strictEqual(first.status, 0, first.stderr);
    const original = fs.readFileSync(sourceFile, 'utf8');
    const rendered = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    assert.match(rendered, /~~~bash shell-example\n"\$GSTACK_BIN\/gstack-config" before/);
    assert.match(rendered, /VALUE=\$\(\(4 << 1\)\)/);
    assert.match(rendered, /\(\( VALUE = 8 << 1 \)\)/);
    assert.match(rendered, /"\$GSTACK_BIN\/gstack-config" after\n~~~~\n/);
    assert.match(rendered, /Later prose \$GSTACK_BIN\/gstack-config must remain prose\./);
    assert.deepStrictEqual(markdownHeredocBodies(rendered), markdownHeredocBodies(original));
    assert.deepStrictEqual(markdownHeredocBodies(rendered), [
      [
        '$HOME/.cursor/skills/gstack/bin/gstack-config',
        '"$GSTACK_BIN/gstack-config"',
        'FIRST',
        '',
      ].join('\n'),
      ['\t${HOME}/.cursor/skills/gstack/lib/redact-audit-log.ts', '\tSECOND', ''].join('\n'),
      ['~/.cursor/skills/gstack/review/checklist.md', 'THIRD', ''].join('\n'),
    ]);

    const secondRoot = path.join(home, 'second-gstack-source');
    fs.cpSync(gstackRoot, secondRoot, { recursive: true });
    const secondSource = path.join(secondRoot, '.cursor', 'skills', 'gstack-heredoc-safety');
    fs.writeFileSync(path.join(secondSource, 'SKILL.md'), rendered);
    const secondTarget = path.join(home, 'second-render', 'gstack-heredoc-safety');
    const second = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', secondSource, secondTarget], {
      encoding: 'utf8',
    });
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(fs.readFileSync(path.join(secondTarget, 'SKILL.md'), 'utf8'), rendered);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] quote-removal de delimiter heredoc segue Bash e retoma renderização', () => {
  const home = freshHome();
  try {
    const cases = [
      {
        label: 'double',
        opener: 'cat <<"E\\Q" >/dev/null',
        body: ['$HOME/.cursor/skills/gstack/bin/gstack-config'],
        terminator: 'E\\Q',
      },
      {
        label: 'single',
        opener: "cat <<'S\\Q' >/dev/null",
        body: ['"$GSTACK_BIN/gstack-config"'],
        terminator: 'S\\Q',
      },
      {
        label: 'escaped',
        opener: 'cat <<RAW\\ END >/dev/null',
        body: ['${HOME}/.cursor/skills/gstack/lib/redact-audit-log.ts'],
        terminator: 'RAW END',
      },
      {
        label: 'ansi',
        opener: "cat <<$'ANSI\\x2dEND' >/dev/null",
        body: ['~/.cursor/skills/gstack/review/checklist.md'],
        terminator: 'ANSI-END',
      },
      {
        label: 'locale',
        opener: 'cat <<$"LOCALE\\Q" >/dev/null',
        body: ['$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md'],
        terminator: 'LOCALE\\Q',
      },
    ];

    const behavior = ['set -eu'];
    for (const item of cases) {
      behavior.push(item.opener, ...item.body, item.terminator, `printf '${item.label}\\n'`);
    }
    const executed = spawnSync('bash', ['-c', behavior.join('\n')], { encoding: 'utf8' });
    assert.strictEqual(executed.status, 0, `${executed.stderr}\n${executed.stdout}`);
    assert.strictEqual(executed.stdout, `${cases.map(({ label }) => label).join('\n')}\n`,
      'Bash deve reconhecer cada delimiter e executar a linha posterior');

    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-heredoc-quote-removal']);
    const source = path.join(generated, 'gstack-heredoc-quote-removal');
    const sourceLines = [
      '---',
      'name: gstack-heredoc-quote-removal',
      'description: hostile heredoc delimiter fixture',
      '---',
      '```bash',
    ];
    for (const item of cases) {
      sourceLines.push(
        item.opener,
        ...item.body,
        item.terminator,
        `$GSTACK_BIN/gstack-config after-${item.label}`,
      );
    }
    sourceLines.push('```', '');
    fs.writeFileSync(path.join(source, 'SKILL.md'), sourceLines.join('\n'));

    const target = path.join(home, 'rendered', 'gstack-heredoc-quote-removal');
    const renderedResult = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', source, target], {
      encoding: 'utf8',
    });
    assert.strictEqual(renderedResult.status, 0, renderedResult.stderr);
    const rendered = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    for (const item of cases) {
      const exact = [item.opener, ...item.body, item.terminator].join('\n');
      assert.ok(rendered.includes(exact), `${item.label}: corpo/delimiter devem permanecer byte-exatos`);
      assert.match(
        rendered,
        new RegExp(`"\\$GSTACK_BIN/gstack-config" after-${item.label}\\n`),
        `${item.label}: render deve retomar imediatamente após o delimiter`,
      );
    }

    const secondRoot = path.join(home, 'second-gstack-source');
    fs.cpSync(gstackRoot, secondRoot, { recursive: true });
    const secondSource = path.join(secondRoot, '.cursor', 'skills', 'gstack-heredoc-quote-removal');
    fs.writeFileSync(path.join(secondSource, 'SKILL.md'), rendered);
    const secondTarget = path.join(home, 'second-render', 'gstack-heredoc-quote-removal');
    const rerendered = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', secondSource, secondTarget], {
      encoding: 'utf8',
    });
    assert.strictEqual(rerendered.status, 0, rerendered.stderr);
    assert.strictEqual(fs.readFileSync(path.join(secondTarget, 'SKILL.md'), 'utf8'), rendered);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] heredoc oracle Bash preserva NUL ANSI-C, controles e LF/CRLF/misto byte-exatos', () => {
  const home = freshHome();
  try {
    const control = String.fromCharCode(0x1f);
    const cases = [
      {
        label: 'nul',
        opener: "cat <<$'NUL\\0IGNORED'POST >/dev/null\n",
        body: '$HOME/.cursor/skills/gstack/bin/gstack-config\n',
        terminator: 'NULPOST\n',
        post: ": $GSTACK_BIN/gstack-config; printf 'nul\\n'\n",
      },
      {
        label: 'control',
        opener: "cat <<$'CTRL\\x1fEND' >/dev/null\n",
        body: '${HOME}/.cursor/skills/gstack/lib/redact-audit-log.ts\n',
        terminator: `CTRL${control}END\n`,
        post: ": $GSTACK_BIN/gstack-config; printf 'control\\n'\n",
      },
      {
        label: 'crlf',
        opener: 'cat >/dev/null <<CRLF\r\n',
        body: '~/.cursor/skills/gstack/review/checklist.md\r\n',
        terminator: 'CRLF\r\n',
        post: ": $GSTACK_BIN/gstack-config; printf 'crlf\\n'\n",
      },
      {
        label: 'mixed',
        opener: 'cat >/dev/null <<MIXED\n',
        body: '$GSTACK_ROOT/plan-devex-review/dx-hall-of-fame.md\r\n',
        terminator: 'MIXED\n',
        post: ": $GSTACK_BIN/gstack-config; printf 'mixed\\n'\n",
      },
    ];
    const shellBody = cases.map((item) => (
      item.opener + item.body + item.terminator + item.post
    )).join('');
    const oracle = spawnSync('bash', ['-c', shellBody], { encoding: 'utf8' });
    assert.strictEqual(oracle.status, 0, `${oracle.stderr}\n${oracle.stdout}`);
    assert.strictEqual(oracle.stderr, '', oracle.stderr);
    assert.strictEqual(oracle.stdout, 'nul\ncontrol\ncrlf\nmixed\n');

    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-heredoc-physical-lines']);
    const source = path.join(generated, 'gstack-heredoc-physical-lines');
    const sourceFile = path.join(source, 'SKILL.md');
    const markdown = [
      '---\nname: gstack-heredoc-physical-lines\ndescription: physical lines\n---\n```bash\n',
      shellBody,
      '```\n',
    ].join('');
    fs.writeFileSync(sourceFile, markdown);
    const target = path.join(home, 'rendered', 'gstack-heredoc-physical-lines');
    const synced = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', source, target], {
      encoding: 'utf8',
    });
    assert.strictEqual(synced.status, 0, synced.stderr);
    const rendered = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    for (const item of cases) {
      const exactHeredoc = item.opener + item.body + item.terminator;
      assert.ok(rendered.includes(exactHeredoc), `${item.label}: heredoc deve ser byte-exato`);
      assert.ok(
        rendered.includes(item.post.replace('$GSTACK_BIN/gstack-config', '"$GSTACK_BIN/gstack-config"')),
        `${item.label}: referência após terminator deve ser transformada`,
      );
    }
    assert.strictEqual(
      spawnSync(process.execPath, [GSTACK_TOOL, 'skill-verify', source, target], { encoding: 'utf8' }).status,
      0,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] heredoc oracle Bash mantém substituições balanceadas como delimiter literal', () => {
  const home = freshHome();
  try {
    const cases = [
      {
        label: 'command',
        opener: 'cat <<$(printf EOF) >/dev/null\n',
        body: '$GSTACK_BIN/gstack-config command-body\n',
        terminator: '$(printf EOF)\n',
      },
      {
        label: 'command-quotes',
        opener: 'cat <<$(printf "E O F") >/dev/null\n',
        body: '$GSTACK_BIN/gstack-config quoted-command-body\n',
        terminator: '$(printf E O F)\n',
      },
      {
        label: 'arithmetic',
        opener: 'cat <<$((1 + (2 * 3))) >/dev/null\n',
        body: '$GSTACK_BIN/gstack-config arithmetic-body\n',
        terminator: '$((1 + (2 * 3)))\n',
      },
      {
        label: 'backtick',
        opener: 'cat <<`printf "EOF"` >/dev/null\n',
        body: '$GSTACK_BIN/gstack-config backtick-body\n',
        terminator: '`printf EOF`\n',
      },
    ];
    const shellBody = cases.map((item) => [
      item.opener,
      item.body,
      item.terminator,
      `: $GSTACK_BIN/gstack-config; printf '${item.label}\\n'\n`,
    ].join('')).join('');
    const oracle = spawnSync('bash', ['-c', shellBody], { encoding: 'utf8' });
    assert.strictEqual(oracle.status, 0, `${oracle.stderr}\n${oracle.stdout}`);
    assert.strictEqual(oracle.stderr, '', oracle.stderr);
    assert.strictEqual(oracle.stdout, `${cases.map(({ label }) => label).join('\n')}\n`);

    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-heredoc-expansions']);
    const source = path.join(generated, 'gstack-heredoc-expansions');
    const sourceFile = path.join(source, 'SKILL.md');
    fs.writeFileSync(sourceFile, [
      '---\nname: gstack-heredoc-expansions\ndescription: balanced expansions\n---\n```bash\n',
      shellBody,
      '```\n',
    ].join(''));
    const target = path.join(home, 'rendered', 'gstack-heredoc-expansions');
    const first = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', source, target], {
      encoding: 'utf8',
    });
    assert.strictEqual(first.status, 0, first.stderr);
    const rendered = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    for (const item of cases) {
      assert.ok(rendered.includes(item.opener + item.body + item.terminator), item.label);
      assert.match(rendered, new RegExp(`"\\$GSTACK_BIN/gstack-config"; printf '${item.label}`));
    }

    const secondRoot = path.join(home, 'second-gstack-source');
    fs.cpSync(gstackRoot, secondRoot, { recursive: true });
    const secondSource = path.join(secondRoot, '.cursor', 'skills', 'gstack-heredoc-expansions');
    fs.writeFileSync(path.join(secondSource, 'SKILL.md'), rendered);
    const secondTarget = path.join(home, 'second-render', 'gstack-heredoc-expansions');
    const second = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', secondSource, secondTarget], {
      encoding: 'utf8',
    });
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(fs.readFileSync(path.join(secondTarget, 'SKILL.md'), 'utf8'), rendered);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] heredoc inválido falha fechado em sync, verify e manifesto', () => {
  const variants = [
    {
      name: 'unterminated',
      shell: 'cat <<EOF\n$GSTACK_BIN/gstack-config protected forever\n',
    },
    {
      name: 'crlf-mismatch',
      shell: 'cat <<MIXED\r\n$GSTACK_BIN/gstack-config protected\r\nMIXED\n$GSTACK_BIN/gstack-config remainder\n',
    },
    {
      name: 'unsupported-quote',
      shell: "cat <<'BROKEN\n$GSTACK_BIN/gstack-config remainder\n",
    },
    {
      name: 'nul-unquoted-escaped',
      shell: 'cat <<BAD\\\0DELIMITER\n$GSTACK_BIN/gstack-config remainder\nBAD\n',
    },
    {
      name: 'nul-double-escaped',
      shell: 'cat <<"BAD\\\0DELIMITER"\n$GSTACK_BIN/gstack-config remainder\nBAD\n',
    },
    {
      name: 'nul-locale-escaped',
      shell: 'cat <<$"BAD\\\0DELIMITER"\n$GSTACK_BIN/gstack-config remainder\nBAD\n',
    },
    {
      name: 'nul-ansi-escaped',
      shell: "cat <<$'BAD\\\0DELIMITER'\n$GSTACK_BIN/gstack-config remainder\nBAD\n",
    },
    {
      name: 'command-nesting',
      shell: 'cat <<$(printf EOF\n$GSTACK_BIN/gstack-config remainder\n',
    },
    {
      name: 'arithmetic-nesting',
      shell: 'cat <<$((1 + 2)\n$GSTACK_BIN/gstack-config remainder\n',
    },
    {
      name: 'backtick-nesting',
      shell: 'cat <<`printf EOF\n$GSTACK_BIN/gstack-config remainder\n',
    },
  ];
  for (const variant of variants) {
    const home = freshHome();
    try {
      const gstackRoot = path.join(home, 'gstack-source');
      const skillName = `gstack-heredoc-invalid-${variant.name}`;
      const generated = createGstackFixture(gstackRoot, [skillName]);
      const source = path.join(generated, skillName);
      const sourceFile = path.join(source, 'SKILL.md');
      const target = path.join(home, 'rendered', skillName);
      const initial = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-sync', source, target], {
        encoding: 'utf8',
      });
      assert.strictEqual(initial.status, 0, initial.stderr);
      const before = snapshotTree(target);
      fs.writeFileSync(sourceFile, [
        `---\nname: ${skillName}\ndescription: invalid heredoc\n---\n\`\`\`bash\n`,
        variant.shell,
        '\`\`\`\n',
      ].join(''));

      const parseOnly = spawnSync(process.execPath, [GSTACK_TOOL, 'skill-parse-verify', source], {
        encoding: 'utf8',
      });
      assert.notStrictEqual(parseOnly.status, 0, `${variant.name} skill-parse-verify`);
      assert.match(parseOnly.stderr, /invalid shell heredoc|heredoc delimiter|literal NUL/);

      for (const action of ['skill-sync', 'skill-verify']) {
        const result = spawnSync(process.execPath, [GSTACK_TOOL, action, source, target], {
          encoding: 'utf8',
        });
        assert.notStrictEqual(result.status, 0, `${variant.name} ${action}`);
        assert.match(result.stderr, /invalid shell heredoc|heredoc delimiter|literal NUL/);
        assert.deepStrictEqual(snapshotTree(target), before, `${variant.name} ${action}: target mutado`);
      }

      const manifest = spawnSync(process.execPath, [
        path.join(REPO_ROOT, 'scripts', 'cursor-skill-manifest.mjs'), REPO_ROOT, gstackRoot,
      ], { encoding: 'utf8' });
      assert.notStrictEqual(manifest.status, 0, variant.name);
      assert.strictEqual(manifest.stdout, '', `${variant.name}: manifesto parcial vazou`);
      assert.match(manifest.stderr, /invalid generated Cursor skill|invalid shell heredoc|heredoc delimiter/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] checkout gstack real passa runtime-sync + runtime-verify sem shims', {
  skip: !HAVE_REAL_GSTACK && REAL_GSTACK_SKIP,
}, () => {
  const home = freshHome();
  const assertGstackIntact = realGstackGuard();
  try {
    const skills = path.join(home, 'skills');
    const runtime = path.join(home, 'jarvis-runtime', 'gstack');
    fs.mkdirSync(skills);
    const sync = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-sync', REAL_GSTACK_ROOT, runtime, skills,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(sync.status, 0, `${sync.stderr}\n${sync.stdout}`);
    const verify = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', REAL_GSTACK_ROOT, runtime, skills,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);
    assert.strictEqual(fs.lstatSync(path.join(REAL_GSTACK_ROOT, 'bin', 'gstack-gbrain-sync'), {
      throwIfNoEntry: false,
    }), undefined, 'integração não pode depender de shim extensionless');
    assertGstackIntact();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] runtime/state gstack rejeitam parent symlink e preservam externo byte/mode', () => {
  for (const attack of ['runtime-parent', 'state']) {
    const home = freshHome();
    try {
      const gstackRoot = path.join(home, 'gstack-source');
      createGstackFixture(gstackRoot, ['gstack-review']);
      const cursorRoot = path.join(home, 'cursor-home');
      const skills = path.join(cursorRoot, 'skills');
      const runtimeRoot = path.join(cursorRoot, 'jarvis-runtime');
      const runtime = path.join(runtimeRoot, 'gstack');
      const external = path.join(home, `external-${attack}`);
      fs.mkdirSync(skills, { recursive: true, mode: 0o700 });
      fs.mkdirSync(external, { mode: 0o711 });
      fs.chmodSync(external, 0o711);
      fs.writeFileSync(path.join(external, 'sentinel'), 'EXTERNAL_SAFE\n', { mode: 0o640 });
      fs.chmodSync(path.join(external, 'sentinel'), 0o640);
      if (attack === 'runtime-parent') {
        fs.symlinkSync(external, runtimeRoot);
      } else {
        fs.mkdirSync(runtimeRoot, { mode: 0o700 });
        fs.symlinkSync(external, path.join(runtimeRoot, 'gstack-state'));
      }
      const externalBefore = snapshotTree(external);
      const result = spawnSync(process.execPath, [
        GSTACK_TOOL,
        'runtime-sync',
        fs.realpathSync(gstackRoot),
        runtime,
        skills,
      ], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0, `${attack}: ${result.stderr}`);
      assert.match(result.stderr, /runtime root .*symlink ancestor|runtime root is not a private real directory|state is not a real directory/i);
      assert.deepStrictEqual(snapshotTree(external), externalBefore, `${attack}: external changed`);
      assert.strictEqual(fs.lstatSync(runtime, { throwIfNoEntry: false }), undefined,
        `${attack}: runtime target created`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] runtime gstack rejeita ancestor symlink user-controlled acima do CursorHome', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    const external = path.join(home, 'external-ancestor');
    const alias = path.join(home, 'cursor-parent-alias');
    const cursorRoot = path.join(alias, 'cursor-home');
    const externalCursor = path.join(external, 'cursor-home');
    fs.mkdirSync(path.join(externalCursor, 'skills'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(externalCursor, 'jarvis-runtime'), { mode: 0o700 });
    fs.writeFileSync(path.join(external, 'sentinel'), 'EXTERNAL_SAFE\n', { mode: 0o640 });
    fs.chmodSync(path.join(external, 'sentinel'), 0o640);
    fs.symlinkSync(external, alias);
    const before = snapshotTree(external);
    const result = spawnSync(process.execPath, [
      GSTACK_TOOL,
      'runtime-sync',
      fs.realpathSync(gstackRoot),
      path.join(cursorRoot, 'jarvis-runtime', 'gstack'),
      path.join(cursorRoot, 'skills'),
    ], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /user-controlled symlink ancestor/);
    assert.deepStrictEqual(snapshotTree(external), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] antigos hooks argv/fd/env ficam inertes nos entrypoints de produção', () => {
  const home = freshHome();
  try {
    const cursorRoot = path.join(home, 'cursor-home');
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-review']);
    const oldArg = '--jarvis-test-ipc=3:4';
    // Idem runCursorDoctor: este runner também pinava à mão e deixava
    // CURSOR_BACKUP_DIR/GSTACK_MIGRATED_DIR/JARVIS_BRAIN_HOME/
    // JARVIS_CORTEX_CONFIG herdáveis do ambiente. As de teste vêm DEPOIS do
    // spread — cursorFixtureEnv não define nenhuma delas, então nada é perdido.
    const inheritedEnv = {
      ...process.env,
      ...cursorFixtureEnv(home, { cursorHome: cursorRoot, gstackRoot }),
      JARVIS_TEST_IPC: '1',
      JARVIS_TEST_FAIL_FINALIZE: '1',
      NODE_OPTIONS: '--no-warnings',
    };
    const bootstrap = spawnSync('bash', [SCRIPT, oldArg], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: inheritedEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    assert.strictEqual(bootstrap.status, 2);
    assert.match(bootstrap.stderr.toString(), /Argumento desconhecido/);
    assert.strictEqual(fs.lstatSync(cursorRoot, { throwIfNoEntry: false }), undefined);

    const cursorTarget = path.join(home, 'cursor-copy-target');
    const cursorCopy = spawnSync(process.execPath, [
      CURSOR_COPY_TOOL,
      'sync',
      path.join(REPO_ROOT, 'active', 'skills', 'impeccable'),
      cursorTarget,
      '',
      oldArg,
    ], { encoding: 'utf8', env: inheritedEnv, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    assert.strictEqual(cursorCopy.status, 2, cursorCopy.stderr.toString());
    assert.match(cursorCopy.stderr.toString(), /unsupported Cursor copy transaction option/);
    assert.strictEqual(fs.lstatSync(cursorTarget, { throwIfNoEntry: false }), undefined);

    const gstackTarget = path.join(home, 'gstack-copy-target');
    const gstackCopy = spawnSync(process.execPath, [
      GSTACK_TOOL,
      'skill-sync',
      path.join(generated, 'gstack-review'),
      gstackTarget,
      '',
      gstackRoot,
      oldArg,
    ], { encoding: 'utf8', env: inheritedEnv, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    assert.strictEqual(gstackCopy.status, 2, gstackCopy.stderr.toString());
    assert.match(gstackCopy.stderr.toString(), /unsupported gstack transaction option/);
    assert.strictEqual(fs.lstatSync(gstackTarget, { throwIfNoEntry: false }), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] output real completo não deixa paths runtime inseguros com CURSOR_HOME hostil', {
  skip: !HAVE_REAL_GSTACK && REAL_GSTACK_SKIP,
  timeout: 60000,
}, () => {
  const home = freshHome();
  const assertGstackIntact = realGstackGuard();
  try {
    const hostileCursorHome = path.join(home, 'Cursor Home With Spaces\nAnd Newline');
    const installed = runBootstrap(home, {
      gstackRoot: REAL_GSTACK_ROOT,
      cursorHome: hostileCursorHome,
      // The real gstack checkout takes longer than the hermetic 30s default
      // (~30s measured), so it opts into a wider spawn deadline.
      // This 55s IS the deadline. The test-level `timeout: 60000` above cannot
      // fire while this runs: spawnSync blocks the event loop, so node:test's
      // timer never gets a tick. Verified — a `{ timeout: 300 }` test that
      // spawnSync-blocks for 2s passes. Treat 60000 as documentation of intent
      // and a backstop for any future async work in this test body, never as
      // the bound on the bootstrap itself.
      spawnTimeout: 55000,
    });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);

    const gstackRows = new Map(fs.readFileSync(
      path.join(hostileCursorHome, 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    ).split('\n').filter(Boolean).map((line) => line.split('\t'))
      .filter((fields) => fields[3] === 'gstack')
      .map(([name, source]) => [name, source]));
    const sourceNames = fs.readdirSync(path.join(REAL_GSTACK_ROOT, '.cursor', 'skills'))
      .filter((name) => /^gstack(?:-|$)/.test(name)
        && fs.lstatSync(path.join(REAL_GSTACK_ROOT, '.cursor', 'skills', name)).isDirectory())
      .sort();
    const installedNames = fs.readdirSync(path.join(hostileCursorHome, 'skills'))
      .filter((name) => gstackRows.has(name))
      .sort();
    assert.strictEqual(installedNames.length, sourceNames.length,
      'cada source leaf real deve produzir uma skill com seu nome canônico de frontmatter');

    const markdown = [];
    function visit(current, skillName) {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(current)) {
          if (name !== '.jarvis-cortex-skill.json') visit(path.join(current, name), skillName);
        }
      } else if (stat.isFile() && current.endsWith('.md')) {
        markdown.push({
          label: `${skillName}/${path.relative(path.join(hostileCursorHome, 'skills', skillName), current)}`,
          content: fs.readFileSync(current, 'utf8'),
        });
      }
    }
    let realHeredocCount = 0;
    for (const name of installedNames) {
      visit(path.join(hostileCursorHome, 'skills', name), name);
      const sourceMarkdown = fs.readFileSync(path.join(gstackRows.get(name), 'SKILL.md'), 'utf8');
      const installedMarkdown = fs.readFileSync(path.join(hostileCursorHome, 'skills', name, 'SKILL.md'), 'utf8');
      const sourceHeredocs = markdownHeredocBodies(sourceMarkdown);
      const installedHeredocs = markdownHeredocBodies(installedMarkdown);
      assert.deepStrictEqual(installedHeredocs, sourceHeredocs, `${name}: heredoc bytes devem ser preservados`);
      realHeredocCount += sourceHeredocs.length;
    }
    assert.ok(realHeredocCount > 0, 'checkout real deve exercitar heredocs');
    const unsafe = markdown.flatMap(({ label, content }) => unsafeRuntimeReferencesInMarkdown(content, label));
    assert.deepStrictEqual(unsafe, [], `paths runtime inseguros no output real:\n${unsafe.join('\n')}`);

    const combined = markdown.map(({ content }) => content).join('\n');
    const renderedRoot = '\\$\\{CURSOR_HOME:-\\$HOME\\/\\.cursor\\}\\/jarvis-runtime\\/gstack\\/source';
    for (const relative of [
      'browse/bin/remote-slug',
      'lib/redact-audit-log.ts',
      'review/checklist.md',
      'design-html/vendor/pretext.js',
    ]) {
      assert.match(
        combined,
        new RegExp(`"${renderedRoot}/${relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
        `${relative} deve estar quoted em pelo menos um contexto shell real`,
      );
    }
    assert.match(combined, /echo "READY: \$B"/);
    assert.doesNotMatch(combined, /echo "READY: "\$B""/);
    assertGstackIntact();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack exige Bun no PATH em bootstrap, runtime-sync e runtime-verify', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    const noBunPath = pathWithoutBun(home);
    assert.strictEqual(spawnSync('bun', ['--version'], {
      env: { ...process.env, PATH: noBunPath },
    }).status, null, 'fixture PATH deve realmente ocultar bun');

    const bootstrapMissing = runBootstrap(home, { gstackRoot, path: noBunPath });
    assert.notStrictEqual(bootstrapMissing.code, 0);
    assert.match(bootstrapMissing.stderr, /Bun executable is required on PATH for Cursor gstack skills/);
    assert.strictEqual(snapshotTree(cursorHome(home)), null, 'Bun gate deve preceder a primeira escrita');

    const skills = path.join(home, 'runtime-skills');
    fs.mkdirSync(skills);
    const missingRuntime = path.join(home, 'missing-bun-runtime', 'gstack');
    const runtimeSyncMissing = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-sync', gstackRoot, missingRuntime, skills,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: noBunPath },
    });
    assert.notStrictEqual(runtimeSyncMissing.status, 0);
    assert.match(runtimeSyncMissing.stderr, /Bun executable is required on PATH/);

    const installed = runBootstrap(home, { gstackRoot });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    const runtimeVerifyMissing = spawnSync(process.execPath, [
      GSTACK_TOOL,
      'runtime-verify',
      gstackRoot,
      path.join(cursorHome(home), 'jarvis-runtime', 'gstack'),
      path.join(cursorHome(home), 'skills'),
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: noBunPath },
    });
    assert.notStrictEqual(runtimeVerifyMissing.status, 0);
    assert.match(runtimeVerifyMissing.stderr, /Bun executable is required on PATH/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] bootstrap sem gstack não exige Bun', () => {
  const home = freshHome();
  try {
    const result = runBootstrap(home, { path: pathWithoutBun(home) });
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] prune gstack preserva diretório sem ownership e propaga falha interna', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack', 'gstack-stale']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);

    const staleSource = path.join(generated, 'gstack-stale');
    const staleTarget = path.join(cursorHome(home), 'skills', 'gstack-stale');
    fs.rmSync(staleSource, { recursive: true, force: true });
    fs.rmSync(staleTarget, { recursive: true, force: true });
    fs.mkdirSync(staleTarget, { recursive: true });
    fs.writeFileSync(path.join(staleTarget, 'SKILL.md'), '---\nname: user-stale\ndescription: user owned\n---\n');

    const preserved = runBootstrap(home, { gstackRoot });
    assert.strictEqual(preserved.code, 0, preserved.stderr);
    assert.match(preserved.stderr, /stale Cursor gstack copy .* does not match its previous manifest row; preserving it/);
    assert.match(fs.readFileSync(path.join(staleTarget, 'SKILL.md'), 'utf8'), /user owned/);

    fs.rmSync(staleTarget, { recursive: true, force: true });
    fs.mkdirSync(staleSource, { recursive: true });
    fs.writeFileSync(path.join(staleSource, 'SKILL.md'), '---\nname: gstack-stale\ndescription: fixture\n---\n');
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    fs.rmSync(staleSource, { recursive: true, force: true });

    const failingTool = path.join(home, 'failing-gstack-tool.mjs');
    fs.writeFileSync(failingTool, [
      "import { spawnSync } from 'node:child_process';",
      "if (process.argv[2] === 'skill-remove') {",
      "  process.stderr.write('injected gstack prune failure\\n');",
      '  process.exit(42);',
      '}',
      `const result = spawnSync(process.execPath, [${JSON.stringify(path.join(REPO_ROOT, 'scripts', 'cursor-gstack-install.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n'));
    const failed = runBootstrap(home, { gstackRoot, gstackTool: failingTool });
    assert.strictEqual(failed.code, 42, `${failed.stderr}\n${failed.stdout}`);
    assert.match(failed.stderr, /injected gstack prune failure/);
    assert.ok(fs.existsSync(staleTarget), 'falha inesperada não deve remover a cópia stale');
    assert.doesNotMatch(failed.stdout, /Cursor bootstrap complete/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack rejeita source incompleto e entrypoint sem executabilidade', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    const referencedAsset = path.join(gstackRoot, 'bin', 'gstack-review-read');
    fs.rmSync(referencedAsset);

    const incomplete = runBootstrap(home, { gstackRoot });
    assert.notStrictEqual(incomplete.code, 0, `${incomplete.stderr}\n${incomplete.stdout}`);
    assert.match(incomplete.stderr, /required gstack runtime asset missing: bin\/gstack-review-read/);
    assert.doesNotMatch(incomplete.stdout, /Cursor bootstrap complete/);

    fs.writeFileSync(referencedAsset, '# DX hall of fame\n');
    fs.chmodSync(referencedAsset, 0o755);
    fs.chmodSync(path.join(gstackRoot, 'design', 'dist', 'design'), 0o644);
    const nonExecutable = runBootstrap(home, { gstackRoot });
    assert.notStrictEqual(nonExecutable.code, 0, `${nonExecutable.stderr}\n${nonExecutable.stdout}`);
    assert.match(nonExecutable.stderr, /required gstack runtime asset is not executable: design\/dist\/design/);
    assert.doesNotMatch(nonExecutable.stdout, /Cursor bootstrap complete/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] assets requeridos e launcher gerenciado exigem owner/mode seguros', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-setup-gbrain']);
    const sourceSkill = fs.realpathSync(path.join(generated, 'gstack-setup-gbrain'));
    fs.appendFileSync(path.join(sourceSkill, 'SKILL.md'), [
      '```bash',
      '$GSTACK_BIN/gstack-memory-ingest --probe',
      '$GSTACK_BIN/gstack-gbrain-sync --full',
      '$GSTACK_ROOT/lib/redact-audit-log.ts',
      '```',
      '',
    ].join('\n'));
    for (const script of ['gstack-memory-ingest.ts', 'gstack-gbrain-sync.ts']) {
      fs.writeFileSync(path.join(gstackRoot, 'bin', script), '#!/usr/bin/env bun\nprocess.exit(0);\n');
      fs.chmodSync(path.join(gstackRoot, 'bin', script), 0o644);
    }
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const skills = path.join(cursorHome(home), 'skills');
    const targetSkill = path.join(skills, 'gstack-setup-gbrain');
    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    const launcher = path.join(runtime, 'pair-agent');
    const runGstack = (markerCommand, args) => spawnSync(process.execPath, [
      GSTACK_TOOL, markerCommand, ...args,
    ], { encoding: 'utf8' });
    const runtimeArgs = [fs.realpathSync(gstackRoot), runtime, skills];
    const skillArgs = [sourceSkill, targetSkill];
    assert.strictEqual(runGstack('runtime-verify', runtimeArgs).status, 0);
    assert.strictEqual(runGstack('skill-verify', skillArgs).status, 0);
    for (const script of ['gstack-memory-ingest.ts', 'gstack-gbrain-sync.ts']) {
      assert.strictEqual(fs.lstatSync(path.join(gstackRoot, 'bin', script)).mode & 0o777, 0o644,
        `${script} via Bun não precisa de +x`);
    }

    const sourceAsset = path.join(gstackRoot, 'bin', 'gstack-config');
    const beforeRuntime = snapshotTree(runtime);
    const beforeSkill = snapshotTree(targetSkill);
    fs.chmodSync(sourceAsset, 0o777);
    for (const [markerCommand, args] of [
      ['runtime-verify', runtimeArgs],
      ['runtime-sync', runtimeArgs],
      ['skill-verify', skillArgs],
      ['skill-sync', skillArgs],
    ]) {
      const rejected = runGstack(markerCommand, args);
      assert.notStrictEqual(rejected.status, 0, `${markerCommand}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /required gstack runtime asset bin\/gstack-config is group\/world-writable/);
    }
    assert.deepStrictEqual(snapshotTree(runtime), beforeRuntime);
    assert.deepStrictEqual(snapshotTree(targetSkill), beforeSkill);
    fs.chmodSync(sourceAsset, 0o755);

    for (const [relative, directory] of [
      ['.', gstackRoot],
      ['bin', path.join(gstackRoot, 'bin')],
      ['lib', path.join(gstackRoot, 'lib')],
    ]) {
      const beforeCursor = snapshotTree(cursorHome(home));
      fs.chmodSync(directory, 0o777);
      for (const [markerCommand, args] of [
        ['runtime-verify', runtimeArgs],
        ['runtime-sync', runtimeArgs],
        ['skill-verify', skillArgs],
        ['skill-sync', skillArgs],
      ]) {
        const rejected = runGstack(markerCommand, args);
        assert.notStrictEqual(rejected.status, 0, `${relative} ${markerCommand}: ${rejected.stderr}`);
        assert.match(
          rejected.stderr,
          /(?:required gstack runtime directory (?:\.|bin|lib)|gstack copy root) is group\/world-writable/,
        );
      }
      const bootstrapRejected = runBootstrap(home, { gstackRoot });
      assert.notStrictEqual(bootstrapRejected.code, 0, `${relative}: ${bootstrapRejected.stderr}`);
      assert.match(bootstrapRejected.stderr, /required gstack runtime directory .* is group\/world-writable/);
      assert.deepStrictEqual(snapshotTree(cursorHome(home)), beforeCursor, `${relative}: bootstrap não pode alterar destino`);
      fs.chmodSync(directory, 0o755);
    }

    const bunAsset = path.join(gstackRoot, 'bin', 'gstack-memory-ingest.ts');
    fs.chmodSync(bunAsset, 0o666);
    for (const [markerCommand, args] of [
      ['runtime-verify', runtimeArgs],
      ['skill-verify', skillArgs],
    ]) {
      const rejected = runGstack(markerCommand, args);
      assert.notStrictEqual(rejected.status, 0, `${markerCommand}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /gstack-memory-ingest\.ts is group\/world-writable/);
    }
    fs.chmodSync(bunAsset, 0o644);

    fs.chmodSync(launcher, 0o777);
    const unsafeLauncher = snapshotTree(runtime);
    for (const [markerCommand, args, expectedStatus] of [
      ['runtime-owner-verify', [gstackRoot, runtime], 10],
      ['runtime-sync', runtimeArgs, 10],
      ['runtime-remove', [gstackRoot, runtime], 10],
      ['runtime-verify', runtimeArgs, 1],
    ]) {
      const rejected = runGstack(markerCommand, args);
      assert.strictEqual(rejected.status, expectedStatus, `${markerCommand}: ${rejected.stderr}`);
      assert.deepStrictEqual(snapshotTree(runtime), unsafeLauncher, markerCommand);
    }
    fs.chmodSync(launcher, 0o755);

    const launcherBytes = fs.readFileSync(launcher);
    const externalLauncher = path.join(home, 'external-pair-agent');
    fs.writeFileSync(externalLauncher, launcherBytes, { mode: 0o755 });
    fs.unlinkSync(launcher);
    fs.symlinkSync(externalLauncher, launcher);
    const symlinkedLauncher = snapshotTree(runtime);
    const beforeExternal = snapshotTree(externalLauncher);
    for (const [markerCommand, args, expectedStatus] of [
      ['runtime-owner-verify', [gstackRoot, runtime], 10],
      ['runtime-sync', runtimeArgs, 10],
      ['runtime-remove', [gstackRoot, runtime], 10],
      ['runtime-verify', runtimeArgs, 1],
    ]) {
      const rejected = runGstack(markerCommand, args);
      assert.strictEqual(rejected.status, expectedStatus, `${markerCommand}: ${rejected.stderr}`);
      assert.deepStrictEqual(snapshotTree(runtime), symlinkedLauncher, markerCommand);
      assert.deepStrictEqual(snapshotTree(externalLauncher), beforeExternal, markerCommand);
    }
    fs.unlinkSync(launcher);
    fs.writeFileSync(launcher, launcherBytes, { mode: 0o755 });
    assert.strictEqual(runGstack('runtime-verify', runtimeArgs).status, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] chown foreign em asset/launcher falha quando executado como root', {
  skip: typeof process.getuid !== 'function' || process.getuid() !== 0,
}, () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const skills = path.join(cursorHome(home), 'skills');
    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    const asset = path.join(gstackRoot, 'bin', 'gstack-config');
    fs.chownSync(asset, 1, 1);
    const sourceRejected = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', gstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(sourceRejected.status, 0);
    assert.match(sourceRejected.stderr, /is not owned by the current user/);
    fs.chownSync(asset, 0, 0);

    const binDirectory = path.join(gstackRoot, 'bin');
    fs.chownSync(binDirectory, 1, 1);
    const directoryRejected = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', gstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(directoryRejected.status, 0);
    assert.match(directoryRejected.stderr, /required gstack runtime directory bin is not owned by the current user/);
    const bootstrapRejected = runBootstrap(home, { gstackRoot });
    assert.notStrictEqual(bootstrapRejected.code, 0);
    assert.match(bootstrapRejected.stderr, /runtime directory bin is not owned by the current user/);
    fs.chownSync(binDirectory, 0, 0);

    const launcher = path.join(runtime, 'pair-agent');
    fs.chownSync(launcher, 1, 1);
    const ownershipRejected = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-owner-verify', gstackRoot, runtime,
    ], { encoding: 'utf8' });
    assert.strictEqual(ownershipRejected.status, 10, ownershipRejected.stderr);
    assert.ok(fs.existsSync(runtime));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack runtime exige a dependência incondicional do pair launcher', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const leaf = path.join(gstackRoot, '.cursor', 'skills', 'gstack-minimal');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(
      path.join(leaf, 'SKILL.md'),
      '---\nname: gstack-minimal\ndescription: no runtime references\n---\n',
    );
    const skills = path.join(cursorHome(home), 'skills');
    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    fs.mkdirSync(skills, { recursive: true });

    const missingOnSync = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-sync', gstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(missingOnSync.status, 0, missingOnSync.stderr);
    assert.match(missingOnSync.stderr, /required gstack runtime asset missing: browse\/dist\/browse/);
    assert.strictEqual(fs.lstatSync(runtime, { throwIfNoEntry: false }), undefined);

    const browse = path.join(gstackRoot, 'browse', 'dist', 'browse');
    fs.mkdirSync(path.dirname(browse), { recursive: true });
    fs.writeFileSync(browse, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(browse, 0o755);
    const installed = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-sync', gstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.strictEqual(installed.status, 0, installed.stderr);

    fs.unlinkSync(browse);
    const missingOnVerify = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', gstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(missingOnVerify.status, 0, missingOnVerify.stderr);
    assert.match(missingOnVerify.stderr, /required gstack runtime asset missing: browse\/dist\/browse/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] runtime gstack aceita só raw source absoluto/relativo canônico exato', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const ch = cursorHome(home);
    const skills = path.join(ch, 'skills');
    const runtime = path.join(ch, 'jarvis-runtime', 'gstack');
    const runtimeSource = path.join(runtime, 'source');
    const canonicalGstackRoot = fs.realpathSync(gstackRoot);
    const sourceAlias = path.join(home, 'gstack-source-alias');
    const parentAlias = path.join(home, 'gstack-parent-alias');
    fs.symlinkSync(gstackRoot, sourceAlias);
    fs.symlinkSync(path.dirname(gstackRoot), parentAlias);
    const variants = [
      ['runtime-owner-verify', [canonicalGstackRoot, runtime], 10],
      ['runtime-verify', [canonicalGstackRoot, runtime, skills], 1],
      ['runtime-sync', [canonicalGstackRoot, runtime, skills], 10],
      ['runtime-remove', [canonicalGstackRoot, runtime], 10],
    ];
    const parent = path.dirname(gstackRoot);
    const invalidTargets = new Map([
      ['alias-component', sourceAlias],
      ['alias-plus-dotdot', `${parentAlias}/../${path.basename(parent)}/${path.basename(gstackRoot)}`],
      ['excessive-dotdot', `${gstackRoot}/../${path.basename(gstackRoot)}`],
      ['duplicate-slash', `${parent}//${path.basename(gstackRoot)}`],
      ['dot-component', `${parent}/./${path.basename(gstackRoot)}`],
    ]);
    for (const [label, rawTarget] of invalidTargets) {
      fs.unlinkSync(runtimeSource);
      fs.symlinkSync(rawTarget, runtimeSource);
      const beforeRuntime = snapshotTree(runtime);
      for (const [markerCommand, args, expectedStatus] of variants) {
        const result = spawnSync(process.execPath, [GSTACK_TOOL, markerCommand, ...args], {
          encoding: 'utf8',
        });
        assert.strictEqual(result.status, expectedStatus, `${label}/${markerCommand}: ${result.stderr}`);
        assert.deepStrictEqual(snapshotTree(runtime), beforeRuntime, `${label}/${markerCommand}`);
      }
      const bootstrapRejected = runBootstrap(home, { gstackRoot });
      assert.notStrictEqual(bootstrapRejected.code, 0, `${label}: ${bootstrapRejected.stderr}`);
      assert.match(bootstrapRejected.stderr, /not a Jarvis-managed gstack runtime; preserving it/, label);
      assert.deepStrictEqual(snapshotTree(runtime), beforeRuntime, label);
    }

    fs.unlinkSync(runtimeSource);
    const directRelative = path.relative(runtime, canonicalGstackRoot);
    fs.symlinkSync(directRelative, runtimeSource);
    const ownerAccepted = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-owner-verify', canonicalGstackRoot, runtime,
    ], { encoding: 'utf8' });
    assert.strictEqual(ownerAccepted.status, 0, ownerAccepted.stderr);
    const verifyAccepted = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-verify', canonicalGstackRoot, runtime, skills,
    ], { encoding: 'utf8' });
    assert.strictEqual(verifyAccepted.status, 0, verifyAccepted.stderr);

    fs.unlinkSync(runtimeSource);
    fs.symlinkSync(canonicalGstackRoot, runtimeSource);
    const absoluteAccepted = spawnSync(process.execPath, [
      GSTACK_TOOL, 'runtime-owner-verify', canonicalGstackRoot, runtime,
    ], { encoding: 'utf8' });
    assert.strictEqual(absoluteAccepted.status, 0, absoluteAccepted.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack-copy rejeita leaf symlink sem escrever no destino externo', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = path.join(gstackRoot, '.cursor', 'skills');
    const external = path.join(home, 'external-skill');
    const source = path.join(generated, 'gstack-escape');
    const target = path.join(cursorHome(home), 'skills', 'gstack-escape');
    const skillBytes = Buffer.from('---\nname: gstack-escape\ndescription: external\n---\n');
    const binaryBytes = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(generated, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(external, 'SKILL.md'), skillBytes);
    fs.writeFileSync(path.join(external, 'payload.bin'), binaryBytes);
    fs.symlinkSync(external, source);

    const result = spawnSync(process.execPath, [
      GSTACK_TOOL, 'skill-sync', source, target,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /gstack skill source is not a real directory/);
    assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
    assert.deepStrictEqual(fs.readFileSync(path.join(external, 'SKILL.md')), skillBytes);
    assert.deepStrictEqual(fs.readFileSync(path.join(external, 'payload.bin')), binaryBytes);
    assert.strictEqual(
      fs.lstatSync(path.join(external, '.jarvis-cortex-skill.json'), { throwIfNoEntry: false }),
      undefined,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] gstack-copy de outra proveniência é preservada no sync e no prune', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-review', 'gstack-stale']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);

    const otherRoot = path.join(home, 'other-gstack-source');
    const otherGenerated = createGstackFixture(otherRoot, ['gstack-review', 'gstack-stale']);
    const skills = path.join(cursorHome(home), 'skills');
    for (const name of ['gstack-review', 'gstack-stale']) {
      const target = path.join(skills, name);
      const otherSource = path.join(otherGenerated, name);
      const markerPath = path.join(target, '.jarvis-cortex-skill.json');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      marker.sourcePath = otherSource;
      marker.sourceReal = fs.realpathSync(otherSource);
      fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
      fs.appendFileSync(path.join(target, 'SKILL.md'), `\nFOREIGN_${name}\n`);
    }
    fs.rmSync(path.join(generated, 'gstack-stale'), { recursive: true, force: true });

    const rerun = runBootstrap(home, { gstackRoot });
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.match(rerun.stderr, /not a Jarvis-managed gstack skill; preserving it/);
    assert.match(fs.readFileSync(path.join(skills, 'gstack-review', 'SKILL.md'), 'utf8'), /FOREIGN_gstack-review/);
    assert.match(fs.readFileSync(path.join(skills, 'gstack-stale', 'SKILL.md'), 'utf8'), /FOREIGN_gstack-stale/);
    const manifest = fs.readFileSync(
      path.join(cursorHome(home), 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    );
    assert.doesNotMatch(manifest, /^gstack-(?:review|stale)\t/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] digest gstack cobre diretórios vazios/modos e rejeita FIFO em verify/orphan', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, [
      { name: 'review', sourceLeaf: 'gstack-review' },
    ]);
    const sourceLexical = path.join(generated, 'gstack-review');
    fs.chmodSync(sourceLexical, 0o700);
    const legitimateEmpty = path.join(sourceLexical, 'empty-assets');
    const regularAsset = path.join(sourceLexical, 'asset.txt');
    const executableAsset = path.join(sourceLexical, 'tool.sh');
    fs.mkdirSync(legitimateEmpty);
    fs.writeFileSync(regularAsset, 'asset\n', { mode: 0o644 });
    fs.writeFileSync(executableAsset, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(executableAsset, 0o755);
    const installed = runBootstrap(home, { gstackRoot });
    assert.strictEqual(installed.code, 0, installed.stderr);

    const source = fs.realpathSync(sourceLexical);
    const target = path.join(cursorHome(home), 'skills', 'review');
    const runTool = (command) => spawnSync(process.execPath, [
      GSTACK_TOOL, command, source, target, source, gstackRoot,
    ], { encoding: 'utf8' });
    const verifyHealthy = (label) => {
      const result = runTool('skill-verify');
      assert.strictEqual(result.status, 0, `${label}\n${result.stderr}`);
    };
    verifyHealthy('legitimate empty directory and executable asset');
    assert.ok(fs.lstatSync(path.join(target, 'empty-assets')).isDirectory());
    assert.strictEqual(fs.lstatSync(target).mode & 0o7777, 0o700,
      'gstack-copy must preserve the private source root mode');

    const fifoPath = path.join(target, 'tampered-fifo');
    const mutations = [
      {
        label: 'added empty directory',
        apply() { fs.mkdirSync(path.join(target, 'tampered-empty')); },
        restore() { fs.rmdirSync(path.join(target, 'tampered-empty')); },
      },
      {
        label: 'FIFO',
        apply() {
          const made = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
          assert.strictEqual(made.status, 0, made.stderr);
        },
        restore() { fs.unlinkSync(fifoPath); },
      },
      {
        label: 'regular file mode',
        apply() { fs.chmodSync(path.join(target, 'asset.txt'), 0o600); },
        restore() { fs.chmodSync(path.join(target, 'asset.txt'), 0o644); },
      },
      {
        label: 'directory mode',
        apply() { fs.chmodSync(path.join(target, 'empty-assets'), 0o700); },
        restore() { fs.chmodSync(path.join(target, 'empty-assets'), 0o755); },
      },
      {
        label: 'root directory mode',
        apply() { fs.chmodSync(target, 0o755); },
        restore() { fs.chmodSync(target, 0o700); },
      },
      {
        label: 'executable mode',
        apply() { fs.chmodSync(path.join(target, 'tool.sh'), 0o700); },
        restore() { fs.chmodSync(path.join(target, 'tool.sh'), 0o755); },
      },
    ];

    for (const mutation of mutations) {
      mutation.apply();
      const result = runTool('skill-verify');
      assert.notStrictEqual(result.status, 0, `${mutation.label} must change or invalidate digest`);
      mutation.restore();
      verifyHealthy(`${mutation.label}: restored target`);
    }

    const sourceFifo = path.join(sourceLexical, 'source-fifo');
    const madeSourceFifo = spawnSync('mkfifo', [sourceFifo], { encoding: 'utf8' });
    assert.strictEqual(madeSourceFifo.status, 0, madeSourceFifo.stderr);
    const beforeRejectedSource = snapshotTree(target);
    const rejectedSource = runTool('skill-sync');
    assert.notStrictEqual(rejectedSource.status, 0, rejectedSource.stderr);
    assert.match(rejectedSource.stderr, /unsupported filesystem type/);
    assert.deepStrictEqual(snapshotTree(target), beforeRejectedSource,
      'unsupported source type must fail before target replacement');
    fs.unlinkSync(sourceFifo);

    const savedSource = path.join(home, 'saved-gstack-review');
    fs.renameSync(sourceLexical, savedSource);
    const missingAuthorizedRoot = spawnSync(process.execPath, [
      GSTACK_TOOL, 'skill-orphan-verify', source, target, source,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(missingAuthorizedRoot.status, 0,
      'historical source alone must not replace an explicit authorized gstack root');
    assert.strictEqual(runTool('skill-orphan-verify').status, 0,
      'untampered installed tree must prove the historical orphan tuple');
    for (const mutation of mutations) {
      mutation.apply();
      const result = runTool('skill-orphan-verify');
      assert.notStrictEqual(result.status, 0,
        `${mutation.label} must invalidate orphan ownership proof`);
      mutation.restore();
      assert.strictEqual(runTool('skill-orphan-verify').status, 0,
        `${mutation.label}: exact target must recover orphan proof after undo`);
    }

    fs.renameSync(savedSource, sourceLexical);
    verifyHealthy('byte-identical source restored');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] digest gstack usa framing canônico sem colisão entre conteúdo e records', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, [
      { name: 'review', sourceLeaf: 'gstack-review' },
    ]);
    const sourceLexical = path.join(generated, 'gstack-review');
    const collisionPayload = Buffer.concat([
      Buffer.from('X'), Buffer.from([0]), Buffer.from('F'), Buffer.from([0]),
      Buffer.from('b'), Buffer.from([0]), Buffer.from('420'), Buffer.from([0]), Buffer.from('Y'),
    ]);
    fs.writeFileSync(path.join(sourceLexical, 'a'), collisionPayload, { mode: 0o644 });
    fs.chmodSync(path.join(sourceLexical, 'a'), 0o644);

    const installed = runBootstrap(home, { gstackRoot });
    assert.strictEqual(installed.code, 0, installed.stderr);
    const source = fs.realpathSync(sourceLexical);
    const target = path.join(cursorHome(home), 'skills', 'review');
    const runTool = (command) => spawnSync(process.execPath, [
      GSTACK_TOOL, command, source, target, source, gstackRoot,
    ], { encoding: 'utf8' });
    const healthy = runTool('skill-verify');
    assert.strictEqual(healthy.status, 0, healthy.stderr);

    fs.writeFileSync(path.join(target, 'a'), 'X', { mode: 0o644 });
    fs.chmodSync(path.join(target, 'a'), 0o644);
    fs.writeFileSync(path.join(target, 'b'), 'Y', { mode: 0o644 });
    fs.chmodSync(path.join(target, 'b'), 0o644);
    const collided = runTool('skill-verify');
    assert.notStrictEqual(collided.status, 0,
      'different trees must not collide when file bytes contain legacy record delimiters');

    const savedSource = path.join(home, 'saved-gstack-review');
    fs.renameSync(sourceLexical, savedSource);
    assert.notStrictEqual(runTool('skill-orphan-verify').status, 0,
      'ambiguous legacy bytes must not retain orphan recovery authority');
    fs.renameSync(savedSource, sourceLexical);
    assert.notStrictEqual(runTool('skill-verify').status, 0,
      'restoring source must still expose the tampered installed tree');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] framing compartilhado é versionado, determinístico e aceita nomes de controle', async () => {
  const home = freshHome();
  try {
    const {
      CURSOR_TREE_DIGEST_DOMAIN,
      CURSOR_TREE_DIGEST_VERSION,
      digestCanonicalTree,
    } = await import(CURSOR_TREE_DIGEST_TOOL);
    assert.strictEqual(CURSOR_TREE_DIGEST_DOMAIN, 'jarvis-cursor-tree-digest');
    assert.strictEqual(CURSOR_TREE_DIGEST_VERSION, 1);

    const legacySingle = path.join(home, 'legacy-single');
    const legacySplit = path.join(home, 'legacy-split');
    fs.mkdirSync(legacySingle, { mode: 0o755 });
    fs.mkdirSync(legacySplit, { mode: 0o755 });
    fs.chmodSync(legacySingle, 0o755);
    fs.chmodSync(legacySplit, 0o755);
    fs.writeFileSync(path.join(legacySingle, 'a'), Buffer.concat([
      Buffer.from('X'), Buffer.from([0]), Buffer.from('F'), Buffer.from([0]),
      Buffer.from('b'), Buffer.from([0]), Buffer.from('420'), Buffer.from([0]), Buffer.from('Y'),
    ]), { mode: 0o644 });
    fs.writeFileSync(path.join(legacySplit, 'a'), 'X', { mode: 0o644 });
    fs.writeFileSync(path.join(legacySplit, 'b'), 'Y', { mode: 0o644 });
    assert.notStrictEqual(digestCanonicalTree(legacySingle), digestCanonicalTree(legacySplit));

    const adversarial = path.join(home, 'adversarial-names');
    fs.mkdirSync(adversarial, { mode: 0o755 });
    fs.writeFileSync(path.join(adversarial, 'line\nbreak'), 'newline\n', { mode: 0o644 });
    fs.writeFileSync(path.join(adversarial, 'tab\tname'), 'tab\n', { mode: 0o644 });
    fs.mkdirSync(path.join(adversarial, 'empty\ndir'), { mode: 0o755 });
    const first = digestCanonicalTree(adversarial);
    const second = digestCanonicalTree(adversarial);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.strictEqual(second, first);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] walker compartilhado rejeita hardlink e swaps path/parent após lstat', async () => {
  const home = freshHome();
  try {
    const { digestCanonicalTree, readStableRegularFile } = await import(CURSOR_TREE_DIGEST_TOOL);
    const hardlinkTree = path.join(home, 'hardlink-tree');
    const external = path.join(home, 'external-payload');
    fs.mkdirSync(hardlinkTree);
    fs.writeFileSync(external, 'same bytes\n', { mode: 0o644 });
    fs.linkSync(external, path.join(hardlinkTree, 'asset'));
    assert.throws(
      () => digestCanonicalTree(hardlinkTree),
      /hardlink|link count|nlink/i,
    );

    const pathSwapTree = path.join(home, 'path-swap-tree');
    const pathSwapFile = path.join(pathSwapTree, 'asset');
    const savedPathFile = path.join(home, 'saved-path-asset');
    fs.mkdirSync(pathSwapTree);
    fs.writeFileSync(pathSwapFile, 'inside\n', { mode: 0o644 });
    assert.throws(() => digestCanonicalTree(pathSwapTree, {
      beforeOpenFile({ relative }) {
        if (relative !== 'asset') return;
        fs.renameSync(pathSwapFile, savedPathFile);
        fs.symlinkSync(external, pathSwapFile);
      },
    }), /symlink|symbolic|ELOOP|changed|identity|stable|nofollow/i);
    fs.unlinkSync(pathSwapFile);
    fs.renameSync(savedPathFile, pathSwapFile);

    const parentSwapTree = path.join(home, 'parent-swap-tree');
    const parent = path.join(parentSwapTree, 'nested');
    const savedParent = path.join(home, 'saved-parent');
    const externalParent = path.join(home, 'external-parent');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(externalParent);
    fs.writeFileSync(path.join(parent, 'asset'), 'inside\n', { mode: 0o644 });
    fs.writeFileSync(path.join(externalParent, 'asset'), 'outside\n', { mode: 0o644 });
    assert.throws(() => digestCanonicalTree(parentSwapTree, {
      beforeOpenFile({ relative }) {
        if (relative !== 'nested/asset') return;
        fs.renameSync(parent, savedParent);
        fs.symlinkSync(externalParent, parent);
      },
    }), /changed|identity|outside|stable|nofollow/i);

    const sameInodeRoot = path.join(home, 'same-inode-parent-root');
    const sameInodeParent = path.join(sameInodeRoot, 'nested');
    const movedSameInodeParent = path.join(sameInodeRoot, 'nested-moved');
    const sameInodeFile = path.join(sameInodeParent, 'asset');
    fs.mkdirSync(sameInodeParent, { recursive: true });
    fs.writeFileSync(sameInodeFile, 'same inode\n', { mode: 0o644 });
    assert.throws(() => readStableRegularFile(sameInodeFile, {
      beforeOpen() {
        fs.renameSync(sameInodeParent, movedSameInodeParent);
        fs.symlinkSync(movedSameInodeParent, sameInodeParent);
      },
    }), /ancestor path changed|symlink|stable|safely/i);
    fs.unlinkSync(sameInodeParent);
    fs.renameSync(movedSameInodeParent, sameInodeParent);

    const duringReadTree = path.join(home, 'during-read-tree');
    const duringReadFile = path.join(duringReadTree, 'asset');
    fs.mkdirSync(duringReadTree);
    fs.writeFileSync(duringReadFile, 'before\n', { mode: 0o644 });
    assert.throws(() => digestCanonicalTree(duringReadTree, {
      beforeReadFile({ relative }) {
        if (relative === 'asset') fs.writeFileSync(duringReadFile, 'change\n', { mode: 0o644 });
      },
    }), /changed|stable|size|mode|time/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] relocação gstack aceita previous_source exato para skill e runtime', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);

    const oldRoot = path.join(home, 'old-gstack-source');
    const oldGenerated = createGstackFixture(oldRoot, ['gstack-review']);
    const ch = cursorHome(home);
    const runtime = path.join(ch, 'jarvis-runtime', 'gstack');
    const runtimeMarkerPath = path.join(runtime, '.jarvis-cortex-runtime.json');
    const runtimeRelocated = spawnSync(process.execPath, [
      GSTACK_TOOL,
      'runtime-sync',
      fs.realpathSync(oldRoot),
      runtime,
      path.join(ch, 'skills'),
      fs.realpathSync(gstackRoot),
    ], { encoding: 'utf8' });
    assert.strictEqual(runtimeRelocated.status, 0, runtimeRelocated.stderr);
    const skillTarget = path.join(ch, 'skills', 'gstack-review');
    const skillMarkerPath = path.join(skillTarget, '.jarvis-cortex-skill.json');
    const skillMarker = JSON.parse(fs.readFileSync(skillMarkerPath, 'utf8'));
    skillMarker.sourcePath = fs.realpathSync(path.join(oldGenerated, 'gstack-review'));
    skillMarker.sourceReal = skillMarker.sourcePath;
    fs.writeFileSync(skillMarkerPath, `${JSON.stringify(skillMarker, null, 2)}\n`);
    fs.appendFileSync(path.join(skillTarget, 'SKILL.md'), '\nOLD_RELOCATION\n');

    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const oldSource = fs.realpathSync(path.join(oldGenerated, 'gstack-review'));
    const relocatedManifest = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'gstack-review') fields[1] = oldSource;
      return fields.join('\t');
    }).join('\n');
    fs.writeFileSync(manifestPath, relocatedManifest);

    const rerun = runBootstrap(home, { gstackRoot });
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.doesNotMatch(fs.readFileSync(path.join(skillTarget, 'SKILL.md'), 'utf8'), /OLD_RELOCATION/);
    const newSkillMarker = JSON.parse(fs.readFileSync(skillMarkerPath, 'utf8'));
    assert.strictEqual(newSkillMarker.sourcePath, fs.realpathSync(path.join(generated, 'gstack-review')));
    const newRuntimeMarker = JSON.parse(fs.readFileSync(runtimeMarkerPath, 'utf8'));
    assert.strictEqual(newRuntimeMarker.sourcePath, fs.realpathSync(gstackRoot));
    assert.strictEqual(fs.realpathSync(path.join(runtime, 'source')), fs.realpathSync(gstackRoot));
    assert.deepStrictEqual(
      fs.readFileSync(manifestPath, 'utf8').split('\n')
        .find((line) => line.startsWith('gstack-review\t')).split('\t'),
      ['gstack-review', fs.realpathSync(path.join(generated, 'gstack-review')), 'gstack-copy', 'gstack'],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] runtime marker de outra proveniência falha sem sobrescrever', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const otherRoot = path.join(home, 'other-gstack-source');
    createGstackFixture(otherRoot, ['gstack-review']);

    const runtime = path.join(cursorHome(home), 'jarvis-runtime', 'gstack');
    const markerPath = path.join(runtime, '.jarvis-cortex-runtime.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.sourcePath = otherRoot;
    marker.sourceReal = fs.realpathSync(otherRoot);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    fs.writeFileSync(path.join(runtime, 'FOREIGN_SENTINEL'), 'preserve\n');
    const before = fs.readFileSync(markerPath, 'utf8');

    const directSync = spawnSync(process.execPath, [
      GSTACK_TOOL,
      'runtime-sync',
      gstackRoot,
      runtime,
      path.join(cursorHome(home), 'skills'),
    ], { encoding: 'utf8' });
    assert.strictEqual(directSync.status, 10, `${directSync.stderr}\n${directSync.stdout}`);
    assert.match(directSync.stderr, /runtime is not Jarvis-owned: marker or source identity mismatch/);
    assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(path.join(runtime, 'FOREIGN_SENTINEL'), 'utf8'), 'preserve\n');

    const rerun = runBootstrap(home, { gstackRoot });
    assert.notStrictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.match(rerun.stderr, /not a Jarvis-managed gstack runtime; preserving it/);
    assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(path.join(runtime, 'FOREIGN_SENTINEL'), 'utf8'), 'preserve\n');
    assert.doesNotMatch(rerun.stdout, /Cursor bootstrap complete/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] markers 0600 reais são obrigatórios em verify/sync/remove/stale', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const ch = cursorHome(home);
    const skills = path.join(ch, 'skills');
    const runtime = path.join(ch, 'jarvis-runtime', 'gstack');
    const gstackSkill = path.join(skills, 'gstack-review');
    const impeccable = path.join(skills, 'impeccable');
    const installedManifest = fs.readFileSync(
      path.join(ch, 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    );
    const impeccableSource = installedManifest.split('\n')
      .find((line) => line.startsWith('impeccable\t')).split('\t')[1];
    const targets = [
      {
        label: 'runtime',
        tool: GSTACK_TOOL,
        target: runtime,
        marker: path.join(runtime, '.jarvis-cortex-runtime.json'),
        commands: [
          ['runtime-owner-verify', [gstackRoot, runtime], 10],
          ['runtime-verify', [gstackRoot, runtime, skills], 1],
          ['runtime-sync', [gstackRoot, runtime, skills], 10],
          ['runtime-remove', [gstackRoot, runtime], 10],
        ],
      },
      {
        label: 'gstack skill',
        tool: GSTACK_TOOL,
        target: gstackSkill,
        marker: path.join(gstackSkill, '.jarvis-cortex-skill.json'),
        commands: [
          ['skill-owner-verify', [path.join(gstackRoot, '.cursor', 'skills', 'gstack-review'), gstackSkill], 10],
          ['skill-verify', [path.join(gstackRoot, '.cursor', 'skills', 'gstack-review'), gstackSkill], 1],
          ['skill-sync', [path.join(gstackRoot, '.cursor', 'skills', 'gstack-review'), gstackSkill], 10],
          ['skill-remove', [path.join(gstackRoot, '.cursor', 'skills', 'gstack-review'), gstackSkill], 10],
        ],
      },
      {
        label: 'cursor copy',
        tool: CURSOR_COPY_TOOL,
        target: impeccable,
        marker: path.join(impeccable, '.jarvis-cortex-skill.json'),
        commands: [
          ['owner-verify', [impeccableSource, impeccable], 10],
          ['verify', [impeccableSource, impeccable], 1],
          ['sync', [impeccableSource, impeccable], 10],
          ['remove', [impeccableSource, impeccable], 10],
        ],
      },
    ];

    let runtimeOwnedMarker;
    let runtimeExternalMarker;
    let runtimeExternalSnapshot;
    for (const fixture of targets) {
      assert.strictEqual(fs.lstatSync(fixture.marker).mode & 0o777, 0o600, `${fixture.label}: mode`);
      for (const insecureMode of [0o644, 0o622]) {
        fs.chmodSync(fixture.marker, insecureMode);
        const ownership = spawnSync(process.execPath, [
          fixture.tool,
          fixture.commands[0][0],
          ...fixture.commands[0][1],
        ], { encoding: 'utf8' });
        assert.strictEqual(ownership.status, 10, `${fixture.label} mode ${insecureMode.toString(8)}`);
      }
      fs.chmodSync(fixture.marker, 0o600);

      const ownedMarker = fs.readFileSync(fixture.marker);
      const externalMarker = path.join(home, `external-${fixture.label.replace(' ', '-')}-marker.json`);
      fs.writeFileSync(externalMarker, ownedMarker, { mode: 0o600 });
      fs.unlinkSync(fixture.marker);
      fs.symlinkSync(externalMarker, fixture.marker);
      const beforeTarget = snapshotTree(fixture.target);
      const beforeExternal = snapshotTree(externalMarker);
      for (const [markerCommand, args, expectedStatus] of fixture.commands) {
        const rejected = spawnSync(process.execPath, [fixture.tool, markerCommand, ...args], {
          encoding: 'utf8',
        });
        assert.strictEqual(
          rejected.status,
          expectedStatus,
          `${fixture.label}/${markerCommand}: ${rejected.stderr}`,
        );
        assert.deepStrictEqual(snapshotTree(fixture.target), beforeTarget, `${fixture.label}/${markerCommand}: target`);
        assert.deepStrictEqual(snapshotTree(externalMarker), beforeExternal, `${fixture.label}/${markerCommand}: external`);
      }

      fs.unlinkSync(fixture.marker);
      fs.writeFileSync(fixture.marker, ownedMarker, { mode: 0o600 });
      fs.chmodSync(fixture.marker, 0o600);
      if (fixture.label === 'runtime') {
        runtimeOwnedMarker = ownedMarker;
        runtimeExternalMarker = externalMarker;
        runtimeExternalSnapshot = beforeExternal;
      }
    }

    const stateMarker = path.join(ch, 'jarvis-runtime', 'gstack-state', '.jarvis-cortex-state.json');
    const stateMarkerBytes = fs.readFileSync(stateMarker);
    const externalStateMarker = path.join(home, 'external-state-marker.json');
    fs.writeFileSync(externalStateMarker, stateMarkerBytes, { mode: 0o600 });
    fs.unlinkSync(stateMarker);
    fs.symlinkSync(externalStateMarker, stateMarker);
    const beforeState = snapshotTree(path.dirname(stateMarker));
    const beforeExternalState = snapshotTree(externalStateMarker);
    for (const markerCommand of ['runtime-verify', 'runtime-sync']) {
      const rejected = spawnSync(process.execPath, [
        GSTACK_TOOL, markerCommand, gstackRoot, runtime, skills,
      ], { encoding: 'utf8' });
      assert.notStrictEqual(rejected.status, 0, `${markerCommand}: ${rejected.stderr}`);
      assert.deepStrictEqual(snapshotTree(path.dirname(stateMarker)), beforeState, `${markerCommand}: state`);
      assert.deepStrictEqual(snapshotTree(externalStateMarker), beforeExternalState, `${markerCommand}: external state`);
    }
    fs.unlinkSync(stateMarker);
    fs.writeFileSync(stateMarker, stateMarkerBytes, { mode: 0o600 });

    const runtimeMarker = path.join(runtime, '.jarvis-cortex-runtime.json');
    fs.unlinkSync(runtimeMarker);
    fs.symlinkSync(runtimeExternalMarker, runtimeMarker);
    fs.writeFileSync(path.join(runtime, 'PRESERVE_RUNTIME'), 'preserve\n');
    const manifestTool = createFilteredManifestTool(home, ['gstack-review']);
    const stale = runBootstrap(home, { gstackRoot, manifestTool });
    assert.match(stale.stderr, /does not match the previously managed gstack runtime; preserving it/);
    assert.strictEqual(fs.readFileSync(path.join(runtime, 'PRESERVE_RUNTIME'), 'utf8'), 'preserve\n');
    assert.deepStrictEqual(snapshotTree(runtimeExternalMarker), runtimeExternalSnapshot,
      'stale não pode mutar marker externo');
    fs.unlinkSync(runtimeMarker);
    fs.writeFileSync(runtimeMarker, runtimeOwnedMarker, { mode: 0o600 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] marker de outro uid não prova ownership quando executado como root', {
  skip: typeof process.getuid !== 'function' || process.getuid() !== 0,
}, () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const target = path.join(cursorHome(home), 'skills', 'impeccable');
    const marker = path.join(target, '.jarvis-cortex-skill.json');
    const manifest = fs.readFileSync(
      path.join(cursorHome(home), 'jarvis-cortex-skills.manifest.tsv'),
      'utf8',
    );
    const source = manifest.split('\n').find((line) => line.startsWith('impeccable\t')).split('\t')[1];
    fs.chownSync(marker, 1, 1);
    const before = snapshotTree(target);
    const rejected = spawnSync(process.execPath, [
      CURSOR_COPY_TOOL, 'remove', source, target,
    ], { encoding: 'utf8' });
    assert.strictEqual(rejected.status, 10, rejected.stderr);
    assert.deepStrictEqual(snapshotTree(target), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] stale exato remove link/cursor-copy/runtime e preserva gstack sem source verificável', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const ch = cursorHome(home);
    const omitted = ['hm-init', 'impeccable', 'gstack-review'];
    const manifestTool = createFilteredManifestTool(home, omitted);
    fs.rmSync(gstackRoot, { recursive: true, force: true });

    const rerun = runBootstrap(home, { gstackRoot, manifestTool });
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    for (const name of omitted.filter((name) => name !== 'gstack-review')) {
      assert.strictEqual(
        fs.lstatSync(path.join(ch, 'skills', name), { throwIfNoEntry: false }),
        undefined,
        `${name} stale deveria ser removida`,
      );
    }
    assert.ok(fs.lstatSync(path.join(ch, 'skills', 'gstack-review')).isDirectory());
    assert.match(rerun.stderr, /stale Cursor gstack copy .*gstack-review.*preserving it/);
    assert.strictEqual(
      fs.lstatSync(path.join(ch, 'jarvis-runtime', 'gstack'), { throwIfNoEntry: false }),
      undefined,
      rerun.stderr,
    );
    assert.ok(fs.existsSync(path.join(ch, 'jarvis-runtime', 'gstack-state')),
      'estado privado não deve ser apagado junto com o wrapper');
    const installed = fs.readFileSync(path.join(ch, 'jarvis-cortex-skills.manifest.tsv'), 'utf8');
    for (const name of omitted.filter((name) => name !== 'gstack-review')) {
      assert.doesNotMatch(installed, new RegExp(`^${name}\\t`, 'm'));
    }
    assert.match(installed, /^gstack-review\t.*\tgstack-copy\tgstack$/m,
      'unavailable gstack source must retain the exact installed tuple for recovery');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] tombstone explícita poda source link removido com raw exato abs/rel', () => {
  for (const spelling of ['absolute', 'relative']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
      const fixtureDoctor = path.join(repoRoot, 'scripts', 'doctor.sh');
      const ch = cursorHome(home);
      const installed = runBootstrap(home, { script: fixtureBootstrap });
      assert.strictEqual(installed.code, 0, `${spelling}\n${installed.stderr}\n${installed.stdout}`);

      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const oldSource = path.join(fs.realpathSync(repoRoot), 'active', 'skills', 'learn');
      const target = path.join(ch, 'skills', 'learn');
      fs.appendFileSync(manifestPath, `learn\t${oldSource}\tlink\tcortex\n`);
      if (spelling === 'relative') {
        fs.symlinkSync(path.relative(fs.realpathSync(path.dirname(target)), oldSource), target);
      } else {
        fs.symlinkSync(oldSource, target);
      }
      assert.ok(fs.lstatSync(target).isSymbolicLink());
      assert.strictEqual(fs.existsSync(target), false, 'fixture must be a dangling stale link');

      const before = runCursorDoctor(home, fixtureDoctor, ch);
      assert.strictEqual(before.code, 1, `${spelling}\n${before.stdout}\n${before.stderr}`);
      assert.match(before.stdout, /FAIL\s+Cursor installed skill manifest diverges from desired state: STALE learn/);
      assert.match(before.stdout, /FAIL\s+Cursor managed skill source missing: learn/);

      const reconciled = runBootstrap(home, { script: fixtureBootstrap });
      assert.strictEqual(reconciled.code, 0, `${spelling}\n${reconciled.stderr}\n${reconciled.stdout}`);
      assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false }), undefined, spelling);
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^learn\t/m);

      const after = runCursorDoctor(home, fixtureDoctor, ch);
      assert.strictEqual(after.code, 0, `${spelling}\n${after.stdout}\n${after.stderr}`);
      assert.match(after.stdout, /doctor: \d+ ok, \d+ warn, 0 fail/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] tombstone learn coexiste com gstack learn ativo por tupla exata', () => {
  for (const variant of ['exact-tombstone', 'cross-source', 'wrong-mode', 'wrong-provenance']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
      const gstackRoot = path.join(home, 'gstack-source');
      const generated = createGstackFixture(gstackRoot, ['gstack-learn']);
      const gstackLearn = path.join(generated, 'gstack-learn', 'SKILL.md');
      fs.writeFileSync(
        gstackLearn,
        fs.readFileSync(gstackLearn, 'utf8').replace('name: gstack-learn', 'name: learn'),
      );

      const installed = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
      assert.strictEqual(installed.code, 0, `${variant}\n${installed.stderr}\n${installed.stdout}`);
      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', 'learn');
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const oldSource = path.join(fs.realpathSync(repoRoot), 'active', 'skills', 'learn');
      let recordedSource = oldSource;
      let mode = 'link';
      let provenance = 'cortex';
      if (variant === 'cross-source') {
        recordedSource = path.join(fs.realpathSync(repoRoot), 'active', 'skills', 'dead-code-audit');
      } else if (variant === 'wrong-mode') {
        mode = 'gstack-copy';
        provenance = 'gstack';
      } else if (variant === 'wrong-provenance') {
        provenance = 'hm';
      }

      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(recordedSource, target);
      const rewritten = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
        const fields = line.split('\t');
        return fields[0] === 'learn'
          ? ['learn', recordedSource, mode, provenance].join('\t')
          : line;
      }).join('\n');
      fs.writeFileSync(manifestPath, rewritten);
      const before = snapshotTree(target);

      const reconciled = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
      assert.strictEqual(reconciled.code, 0, `${variant}\n${reconciled.stderr}\n${reconciled.stdout}`);
      const manifest = fs.readFileSync(manifestPath, 'utf8');
      if (variant === 'exact-tombstone') {
        assert.ok(fs.lstatSync(target).isDirectory(), 'tombstone exato deve dar lugar ao gstack ativo');
        assert.match(manifest, new RegExp(
          `^learn\\t${fs.realpathSync(path.join(generated, 'gstack-learn')).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\tgstack-copy\\tgstack$`,
          'm',
        ));
      } else {
        assert.deepStrictEqual(snapshotTree(target), before, variant);
        assert.match(reconciled.stderr, /preserving it/);
        assert.doesNotMatch(manifest, /^learn\t/m);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] stale dangling externo ou raw alias é preservado com warning e nunca removido', () => {
  for (const variant of ['external-source', 'raw-alias']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
      const ch = cursorHome(home);
      assert.strictEqual(runBootstrap(home, { script: fixtureBootstrap }).code, 0);
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const rows = fs.readFileSync(manifestPath, 'utf8').trimEnd().split('\n');
      const index = rows.findIndex((line) => line.startsWith('hm-init\t'));
      const fields = rows[index].split('\t');
      const oldSource = fields[1];
      const target = path.join(ch, 'skills', 'hm-init');
      fs.rmSync(oldSource, { recursive: true });
      fs.unlinkSync(target);
      if (variant === 'external-source') {
        fields[1] = path.join(home, 'external-missing', 'hm-init');
        rows[index] = fields.join('\t');
        fs.writeFileSync(manifestPath, `${rows.join('\n')}\n`);
        fs.symlinkSync(fields[1], target);
      } else {
        fs.symlinkSync(`${path.dirname(oldSource)}/./${path.basename(oldSource)}`, target);
      }
      const rawBefore = fs.readlinkSync(target);

      const rejected = runBootstrap(home, { script: fixtureBootstrap });
      assert.strictEqual(rejected.code, 0, `${variant}\n${rejected.stderr}\n${rejected.stdout}`);
      assert.match(rejected.stderr, /warn: stale Cursor link .*hm-init.*preserving it/);
      assert.ok(fs.lstatSync(target).isSymbolicLink(), variant);
      assert.strictEqual(fs.readlinkSync(target), rawBefore, variant);
      assert.strictEqual(fs.existsSync(target), false, variant);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] prune de link stale preserva alias, file, dir e copy divergentes com warning', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const ch = cursorHome(home);
    assert.strictEqual(runBootstrap(home, { script: fixtureBootstrap }).code, 0);
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const rows = [];
    const snapshots = new Map();
    const alternate = path.join(home, 'alternate-skill');
    fs.mkdirSync(alternate);
    fs.writeFileSync(path.join(alternate, 'SKILL.md'), '---\nname: alternate\ndescription: preserve\n---\n');

    const repoReal = fs.realpathSync(repoRoot);
    for (const kind of ['alias', 'file', 'dir', 'copy']) {
      const name = `stale-${kind}`;
      const source = path.join(repoReal, 'active', 'skills', name);
      const target = path.join(ch, 'skills', name);
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: stale fixture\n---\n`);
      if (kind === 'alias') {
        fs.symlinkSync(alternate, target);
      } else if (kind === 'file') {
        fs.writeFileSync(target, 'preserve regular file\n', { mode: 0o600 });
      } else {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'PRESERVE'), `${kind}\n`);
        if (kind === 'copy') {
          fs.writeFileSync(path.join(target, '.jarvis-cortex-skill.json'), '{}\n', { mode: 0o600 });
        }
      }
      rows.push(`${name}\t${source}\tlink\tcortex`);
      snapshots.set(target, snapshotTree(target));
    }
    fs.appendFileSync(manifestPath, `${rows.join('\n')}\n`);

    const reconciled = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(reconciled.code, 0, `${reconciled.stderr}\n${reconciled.stdout}`);
    for (const kind of ['alias', 'file', 'dir', 'copy']) {
      const target = path.join(ch, 'skills', `stale-${kind}`);
      assert.deepStrictEqual(snapshotTree(target), snapshots.get(target), kind);
      assert.match(reconciled.stderr, new RegExp(`warn: stale Cursor link .*stale-${kind}.*preserving it`));
      assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), new RegExp(`^stale-${kind}\\t`, 'm'));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] stale manifest não pode reivindicar skill válida arbitrária nem nome divergente', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const ch = cursorHome(home);
    assert.strictEqual(runBootstrap(home, { script: fixtureBootstrap }).code, 0);
    const repoReal = fs.realpathSync(repoRoot);
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const injected = [
      {
        name: 'theme-factory',
        source: path.join(repoReal, 'codex', 'skills-local', 'theme-factory'),
        provenance: 'hm',
      },
      {
        name: 'dead-code-renamed',
        source: path.join(repoReal, 'active', 'skills', 'dead-code-audit'),
        provenance: 'cortex',
      },
    ];
    for (const row of injected) {
      const target = path.join(ch, 'skills', row.name);
      fs.symlinkSync(row.source, target);
      row.target = target;
      row.before = snapshotTree(target);
      fs.appendFileSync(manifestPath, `${row.name}\t${row.source}\tlink\t${row.provenance}\n`);
    }

    const reconciled = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(reconciled.code, 0, `${reconciled.stderr}\n${reconciled.stdout}`);
    const finalManifest = fs.readFileSync(manifestPath, 'utf8');
    for (const row of injected) {
      assert.deepStrictEqual(snapshotTree(row.target), row.before, row.name);
      assert.match(reconciled.stderr,
        new RegExp(`warn: stale Cursor link .*${row.name}.*preserving it`));
      assert.doesNotMatch(finalManifest, new RegExp(`^${row.name}\\t`, 'm'));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] stale link:cortex injetado não converte Impeccable user symlink em copy', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const ch = cursorHome(home);
    assert.strictEqual(runBootstrap(home, { script: fixtureBootstrap }).code, 0);

    const target = path.join(ch, 'skills', 'impeccable');
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const source = path.join(fs.realpathSync(repoRoot), 'active', 'skills', 'impeccable');
    fs.rmSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, 'USER_SYMLINK_CONTENT'), 'preserve\n');
    fs.symlinkSync(source, target);
    const injected = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'impeccable') return ['impeccable', source, 'link', 'cortex'].join('\t');
      return line;
    }).join('\n');
    fs.writeFileSync(manifestPath, injected);
    const before = snapshotTree(target);

    const reconciled = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(reconciled.code, 0, `${reconciled.stderr}\n${reconciled.stdout}`);
    assert.match(reconciled.stderr, /warn: stale Cursor link .*impeccable.*preserving it/);
    assert.match(reconciled.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.deepStrictEqual(snapshotTree(target), before);
    assert.strictEqual(fs.readFileSync(path.join(target, 'USER_SYMLINK_CONTENT'), 'utf8'), 'preserve\n');
    assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^impeccable\t/m);

    const second = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(second.code, 0, `${second.stderr}\n${second.stdout}`);
    assert.match(second.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.deepStrictEqual(snapshotTree(target), before, 'subsequent run must not claim the preserved link');

  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] stale gstack link:cortex com source exato é preservado por mode/provenance mismatch', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'gstack-review');
    const source = path.join(gstackRoot, '.cursor', 'skills', 'gstack-review');
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    fs.rmSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, 'USER_SYMLINK_CONTENT'), 'preserve\n');
    fs.symlinkSync(source, target);
    const injected = fs.readFileSync(manifestPath, 'utf8').split('\n').map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'gstack-review') return ['gstack-review', source, 'link', 'cortex'].join('\t');
      return line;
    }).join('\n');
    fs.writeFileSync(manifestPath, injected);
    const before = snapshotTree(target);

    const reconciled = runBootstrap(home, { gstackRoot });
    assert.strictEqual(reconciled.code, 0, `${reconciled.stderr}\n${reconciled.stdout}`);
    assert.match(reconciled.stderr, /warn: stale Cursor link .*gstack-review.*preserving it/);
    assert.match(reconciled.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.deepStrictEqual(snapshotTree(target), before);
    assert.strictEqual(fs.readFileSync(path.join(target, 'USER_SYMLINK_CONTENT'), 'utf8'), 'preserve\n');
    assert.doesNotMatch(fs.readFileSync(manifestPath, 'utf8'), /^gstack-review\t/m);

    const second = runBootstrap(home, { gstackRoot });
    assert.strictEqual(second.code, 0, `${second.stderr}\n${second.stdout}`);
    assert.match(second.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.deepStrictEqual(snapshotTree(target), before, 'subsequent run must not claim the preserved link');

    fs.rmSync(source, { recursive: true });
    fs.appendFileSync(manifestPath, `gstack-review\t${source}\tlink\tcortex\n`);
    const danglingBefore = snapshotTree(target);
    const missingSource = runBootstrap(home, { gstackRoot });
    assert.strictEqual(missingSource.code, 0, `${missingSource.stderr}\n${missingSource.stdout}`);
    assert.match(missingSource.stderr, /warn: stale Cursor link .*gstack-review.*preserving it/);
    assert.deepStrictEqual(snapshotTree(target), danglingBefore,
      'pre-manifest migration must not reactivate after a mismatched manifest row');
    assert.strictEqual(fs.existsSync(target), false, 'preserved link must remain dangling');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] stale com ownership/source/mode divergente é preservado e não reivindicado', () => {
  const home = freshHome();
  try {
    const gstackRoot = path.join(home, 'gstack-source');
    createGstackFixture(gstackRoot, ['gstack-review']);
    assert.strictEqual(runBootstrap(home, { gstackRoot }).code, 0);
    const ch = cursorHome(home);
    const skills = path.join(ch, 'skills');

    const customLink = path.join(home, 'custom-hm-init');
    fs.mkdirSync(customLink, { recursive: true });
    fs.writeFileSync(path.join(customLink, 'SKILL.md'), '---\nname: custom-hm-init\ndescription: custom\n---\n');
    fs.unlinkSync(path.join(skills, 'hm-init'));
    fs.symlinkSync(customLink, path.join(skills, 'hm-init'));

    const impeccable = path.join(skills, 'impeccable');
    const impeccableMarkerPath = path.join(impeccable, '.jarvis-cortex-skill.json');
    const impeccableMarker = JSON.parse(fs.readFileSync(impeccableMarkerPath, 'utf8'));
    impeccableMarker.mode = 'gstack-copy';
    fs.writeFileSync(impeccableMarkerPath, `${JSON.stringify(impeccableMarker, null, 2)}\n`);
    fs.appendFileSync(path.join(impeccable, 'SKILL.md'), '\nUSER_IMPECCABLE\n');

    const gstackSkill = path.join(skills, 'gstack-review');
    const gstackMarkerPath = path.join(gstackSkill, '.jarvis-cortex-skill.json');
    const gstackMarker = JSON.parse(fs.readFileSync(gstackMarkerPath, 'utf8'));
    gstackMarker.owner = 'foreign-owner';
    fs.writeFileSync(gstackMarkerPath, `${JSON.stringify(gstackMarker, null, 2)}\n`);
    fs.appendFileSync(path.join(gstackSkill, 'SKILL.md'), '\nUSER_GSTACK\n');

    const otherRoot = path.join(home, 'other-gstack-source');
    createGstackFixture(otherRoot, ['gstack-review']);
    const runtime = path.join(ch, 'jarvis-runtime', 'gstack');
    const runtimeMarkerPath = path.join(runtime, '.jarvis-cortex-runtime.json');
    const runtimeMarker = JSON.parse(fs.readFileSync(runtimeMarkerPath, 'utf8'));
    runtimeMarker.sourcePath = otherRoot;
    runtimeMarker.sourceReal = fs.realpathSync(otherRoot);
    fs.writeFileSync(runtimeMarkerPath, `${JSON.stringify(runtimeMarker, null, 2)}\n`);
    fs.writeFileSync(path.join(runtime, 'USER_RUNTIME'), 'preserve\n');

    const omitted = ['hm-init', 'impeccable', 'gstack-review'];
    const manifestTool = createFilteredManifestTool(home, omitted);
    const rerun = runBootstrap(home, { gstackRoot, manifestTool });
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.match(rerun.stderr, /does not match .*previous manifest row|does not match the previously managed gstack runtime/);
    assert.strictEqual(fs.realpathSync(path.join(skills, 'hm-init')), fs.realpathSync(customLink));
    assert.match(fs.readFileSync(path.join(impeccable, 'SKILL.md'), 'utf8'), /USER_IMPECCABLE/);
    assert.match(fs.readFileSync(path.join(gstackSkill, 'SKILL.md'), 'utf8'), /USER_GSTACK/);
    assert.strictEqual(fs.readFileSync(path.join(runtime, 'USER_RUNTIME'), 'utf8'), 'preserve\n');
    const installed = fs.readFileSync(path.join(ch, 'jarvis-cortex-skills.manifest.tsv'), 'utf8');
    for (const name of omitted) assert.doesNotMatch(installed, new RegExp(`^${name}\\t`, 'm'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] Impeccable é cópia Cursor-rendered sem dependência de Claude/.agents', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const target = path.join(cursorHome(home), 'skills', 'impeccable');
    assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), false);
    assert.ok(fs.existsSync(path.join(target, '.jarvis-cortex-skill.json')));
    const markdown = [
      fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(target, 'reference', 'live.md'), 'utf8'),
      fs.readFileSync(path.join(target, 'reference', 'hooks.md'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(markdown, /\.agents\/skills\/impeccable|\.claude\/skills\/impeccable/);
    assert.match(markdown, /CURSOR_HOME:-\$HOME\/\.cursor/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] cursor-copy rejeita source root symlink sem escrever no externo', () => {
  const home = freshHome();
  try {
    const external = path.join(home, 'external-cursor-skill');
    const source = path.join(home, 'source-link');
    const target = path.join(cursorHome(home), 'skills', 'copied-skill');
    const skillBytes = Buffer.from('---\nname: copied-skill\ndescription: external\n---\n');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'SKILL.md'), skillBytes);
    fs.symlinkSync(external, source);

    const result = spawnSync(process.execPath, [
      CURSOR_COPY_TOOL, 'sync', source, target,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /Cursor skill copy source is not a real directory/);
    assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
    assert.deepStrictEqual(fs.readFileSync(path.join(external, 'SKILL.md')), skillBytes);
    assert.strictEqual(
      fs.lstatSync(path.join(external, '.jarvis-cortex-skill.json'), { throwIfNoEntry: false }),
      undefined,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] cursor-copy digest cobre árvore completa, tipos e modos', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const sourceLexical = path.join(repoRoot, 'active', 'skills', 'impeccable');
    const source = fs.realpathSync(sourceLexical);
    fs.chmodSync(source, 0o700);
    const legitimateEmpty = path.join(source, 'empty-assets');
    const regularAsset = path.join(source, 'asset.txt');
    const executableAsset = path.join(source, 'tool.sh');
    fs.mkdirSync(legitimateEmpty, { mode: 0o755 });
    fs.chmodSync(legitimateEmpty, 0o755);
    fs.writeFileSync(regularAsset, 'asset\n', { mode: 0o644 });
    fs.chmodSync(regularAsset, 0o644);
    fs.writeFileSync(executableAsset, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(executableAsset, 0o755);

    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const installed = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    const target = path.join(cursorHome(home), 'skills', 'impeccable');
    const copyTool = fs.realpathSync(path.join(repoRoot, 'scripts', 'cursor-skill-copy.mjs'));
    const verify = () => spawnSync(process.execPath, [copyTool, 'verify', source, target], {
      encoding: 'utf8',
    });
    const initiallyVerified = verify();
    assert.strictEqual(initiallyVerified.status, 0,
      `legitimate tree, empty dir, and executable must verify\n${initiallyVerified.stderr}`);
    assert.ok(fs.lstatSync(path.join(target, 'empty-assets')).isDirectory());
    assert.strictEqual(fs.lstatSync(target).mode & 0o7777, 0o700,
      'cursor-copy must preserve the private source root mode');

    const fifoPath = path.join(target, 'tampered-fifo');
    const external = path.join(home, 'external-asset');
    fs.writeFileSync(external, 'external\n');
    const mutations = [
      {
        label: 'empty directory',
        apply() { fs.mkdirSync(path.join(target, 'tampered-empty')); },
        restore() { fs.rmdirSync(path.join(target, 'tampered-empty')); },
      },
      {
        label: 'FIFO',
        apply() {
          const made = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
          assert.strictEqual(made.status, 0, made.stderr);
        },
        restore() { fs.unlinkSync(fifoPath); },
      },
      {
        label: 'symlink',
        apply() { fs.symlinkSync(external, path.join(target, 'tampered-link')); },
        restore() { fs.unlinkSync(path.join(target, 'tampered-link')); },
      },
      {
        label: 'regular file mode',
        apply() { fs.chmodSync(path.join(target, 'asset.txt'), 0o600); },
        restore() { fs.chmodSync(path.join(target, 'asset.txt'), 0o644); },
      },
      {
        label: 'directory mode',
        apply() { fs.chmodSync(path.join(target, 'empty-assets'), 0o700); },
        restore() { fs.chmodSync(path.join(target, 'empty-assets'), 0o755); },
      },
      {
        label: 'root directory mode',
        apply() { fs.chmodSync(target, 0o755); },
        restore() { fs.chmodSync(target, 0o700); },
      },
      {
        label: 'executable mode',
        apply() { fs.chmodSync(path.join(target, 'tool.sh'), 0o700); },
        restore() { fs.chmodSync(path.join(target, 'tool.sh'), 0o755); },
      },
    ];
    for (const mutation of mutations) {
      mutation.apply();
      const rejected = verify();
      assert.notStrictEqual(rejected.status, 0, `${mutation.label} must invalidate cursor-copy`);
      mutation.restore();
      const restored = verify();
      assert.strictEqual(restored.status, 0, `${mutation.label}: ${restored.stderr}`);
    }

    const rerun = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.strictEqual(verify().status, 0, 'idempotent rerun must retain a valid canonical digest');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] hardlinks nunca provam integridade de copy, orphan ou marker', () => {
  const home = freshHome();
  try {
    const repoRootLexical = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRootLexical);
    const repoRoot = fs.realpathSync(repoRootLexical);
    const gstackRootLexical = path.join(home, 'gstack-source');
    const generated = createGstackFixture(gstackRootLexical, [
      { name: 'review', sourceLeaf: 'gstack-review' },
    ]);
    const gstackSourceLexical = path.join(generated, 'gstack-review');
    fs.writeFileSync(path.join(gstackSourceLexical, 'asset.txt'), 'asset\n', { mode: 0o644 });
    const gstackRoot = fs.realpathSync(gstackRootLexical);
    const gstackSource = fs.realpathSync(gstackSourceLexical);
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const installed = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);

    const ch = cursorHome(home);
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const cursorSource = path.join(repoRoot, 'active', 'skills', 'impeccable');
    const setups = [
      {
        kind: 'cursor-copy',
        source: cursorSource,
        target: path.join(ch, 'skills', 'impeccable'),
        files: ['SKILL.md', 'reference/adapt.md', '.jarvis-cortex-skill.json'],
        verify() {
          return spawnSync(process.execPath, [
            path.join(repoRoot, 'scripts', 'cursor-skill-copy.mjs'),
            'verify', cursorSource, this.target,
          ], { encoding: 'utf8' });
        },
      },
      {
        kind: 'gstack-copy',
        source: gstackSource,
        sourceLexical: gstackSourceLexical,
        target: path.join(ch, 'skills', 'review'),
        files: ['SKILL.md', 'asset.txt', '.jarvis-cortex-skill.json'],
        verify(command = 'skill-verify') {
          return spawnSync(process.execPath, [
            path.join(repoRoot, 'scripts', 'cursor-gstack-install.mjs'),
            command, gstackSource, this.target, gstackSource, gstackRoot,
          ], { encoding: 'utf8' });
        },
      },
    ];

    for (const setup of setups) {
      for (const relative of setup.files) {
        const candidate = path.join(setup.target, relative);
        const original = fs.readFileSync(candidate);
        const mode = fs.lstatSync(candidate).mode & 0o777;
        const external = path.join(home, `${setup.kind}-${relative.replaceAll('/', '-')}`);
        fs.writeFileSync(external, original, { mode });
        fs.chmodSync(external, mode);
        fs.unlinkSync(candidate);
        fs.linkSync(external, candidate);
        assert.strictEqual(fs.lstatSync(candidate).nlink, 2, `${setup.kind}:${relative}`);

        const rejected = setup.verify();
        assert.notStrictEqual(rejected.status, 0,
          `${setup.kind}:${relative} hardlink must fail verification`);
        if (setup.kind === 'gstack-copy') {
          const saved = path.join(home, `saved-source-${relative.replaceAll('/', '-')}`);
          fs.renameSync(setup.sourceLexical, saved);
          const orphaned = setup.verify('skill-orphan-verify');
          assert.notStrictEqual(orphaned.status, 0,
            `${setup.kind}:${relative} hardlink must fail orphan verification`);
          fs.renameSync(saved, setup.sourceLexical);
        }

        if (relative === '.jarvis-cortex-skill.json') {
          const manifest = fs.readFileSync(manifestPath, 'utf8');
          const rootGuard = runRootGuard(
            'verify', home, repoRoot, ch, manifest,
            path.join(repoRoot, 'scripts', 'cursor-root-guard.mjs'),
          );
          assert.notStrictEqual(rootGuard.status, 0, `${setup.kind}: hardlinked marker root guard`);
          const audit = spawnSync(process.execPath, [
            path.join(repoRoot, 'scripts', 'cursor-skills-audit.mjs'),
            path.join(ch, 'skills'), '--manifests', manifestPath, manifest, repoRoot,
          ], { encoding: 'utf8' });
          assert.strictEqual(audit.status, 0, audit.stderr);
          assert.ok(JSON.parse(audit.stdout).reconciliationErrors.some(
            (finding) => finding.code === 'managed-marker-invalid'
              && finding.name === path.basename(setup.target),
          ), `${setup.kind}: auditor must reject hardlinked marker`);
        }

        fs.unlinkSync(candidate);
        fs.writeFileSync(candidate, original, { mode });
        fs.chmodSync(candidate, mode);
        assert.strictEqual(setup.verify().status, 0, `${setup.kind}:${relative} restore`);
      }
    }

    for (const setup of setups) {
      const sourceFiles = setup.kind === 'cursor-copy'
        ? ['SKILL.md', 'reference/adapt.md']
        : ['SKILL.md', 'asset.txt'];
      for (const relative of sourceFiles) {
        const candidate = path.join(setup.source, relative);
        const original = fs.readFileSync(candidate);
        const mode = fs.lstatSync(candidate).mode & 0o777;
        const external = path.join(home, `source-${setup.kind}-${relative.replaceAll('/', '-')}`);
        fs.writeFileSync(external, original, { mode });
        fs.chmodSync(external, mode);
        const targetBefore = snapshotTree(setup.target);
        const manifestBefore = fs.readFileSync(manifestPath);
        fs.unlinkSync(candidate);
        fs.linkSync(external, candidate);

        const rejected = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
        assert.notStrictEqual(rejected.code, 0,
          `${setup.kind}:${relative} hardlinked source must fail bootstrap`);
        assert.deepStrictEqual(snapshotTree(setup.target), targetBefore,
          `${setup.kind}:${relative} changed target`);
        assert.deepStrictEqual(fs.readFileSync(manifestPath), manifestBefore,
          `${setup.kind}:${relative} changed manifest`);

        fs.unlinkSync(candidate);
        fs.writeFileSync(candidate, original, { mode });
        fs.chmodSync(candidate, mode);
        const recovered = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
        assert.strictEqual(recovered.code, 0, `${setup.kind}:${relative}\n${recovered.stderr}`);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] hardlink em SKILL ou asset é recusado por parser, source guard, root guard e auditor', async () => {
  const home = freshHome();
  try {
    const repoRootLexical = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRootLexical);
    const repoRoot = fs.realpathSync(repoRootLexical);
    const source = path.join(repoRoot, 'active', 'skills', 'dead-code-audit');
    fs.writeFileSync(path.join(source, 'asset.txt'), 'asset\n', { mode: 0o644 });
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const installed = runBootstrap(home, { script: fixtureBootstrap });
    assert.strictEqual(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    const ch = cursorHome(home);
    const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const { parseSkillFrontmatterName } = await import(
      path.join(repoRoot, 'scripts', 'cursor-skill-frontmatter.mjs')
    );
    const { validateLinkSkillSource } = await import(
      path.join(repoRoot, 'scripts', 'cursor-skill-source-guard.mjs')
    );

    for (const relative of ['SKILL.md', 'asset.txt']) {
      const candidate = path.join(source, relative);
      const original = fs.readFileSync(candidate);
      const mode = fs.lstatSync(candidate).mode & 0o777;
      const external = path.join(home, `hardlink-link-source-${relative.replaceAll('/', '-')}`);
      fs.writeFileSync(external, original, { mode });
      fs.chmodSync(external, mode);
      fs.unlinkSync(candidate);
      fs.linkSync(external, candidate);
      assert.strictEqual(fs.lstatSync(candidate).nlink, 2);

      const parsed = parseSkillFrontmatterName(candidate, relative);
      assert.strictEqual(parsed.error?.code, 'unsafe-regular-file', `${relative}: parser`);
      assert.throws(
        () => validateLinkSkillSource(repoRoot, source, `hardlinked ${relative}`),
        /link count|hardlink|private regular file/i,
        `${relative}: source guard`,
      );

      const rootGuard = runRootGuard('verify', home, repoRoot, ch, manifest,
        path.join(repoRoot, 'scripts', 'cursor-root-guard.mjs'));
      assert.notStrictEqual(rootGuard.status, 0, `${relative}: root guard must fail`);
      assert.match(rootGuard.stderr, /link count|hardlink|private regular file/i);

      const audit = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts', 'cursor-skills-audit.mjs'),
        path.join(ch, 'skills'), '--manifests', manifestPath, manifest, repoRoot,
      ], { encoding: 'utf8' });
      assert.strictEqual(audit.status, 0, `${relative}: ${audit.stderr}`);
      const report = JSON.parse(audit.stdout);
      assert.ok(
        report.reconciliationErrors.length > 0
          || report.errors.some((finding) => finding.code === 'unsafe-regular-file'),
        `${relative}: auditor accepted hardlinked link source`,
      );

      fs.unlinkSync(candidate);
      fs.writeFileSync(candidate, original, { mode });
      fs.chmodSync(candidate, mode);
      assert.strictEqual(runRootGuard(
        'verify', home, repoRoot, ch, manifest,
        path.join(repoRoot, 'scripts', 'cursor-root-guard.mjs'),
      ).status, 0, `${relative}: restored source`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] staging digest aborta races source/copy sem trocar target ou manifesto', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const mutation of ['source-after-digest', 'staged-after-copy']) {
      const home = freshHome();
      try {
        const repoRootLexical = path.join(home, 'cortex-fixture');
        copyCortexFixture(repoRootLexical);
        const repoRoot = fs.realpathSync(repoRootLexical);
        const gstackRootLexical = path.join(home, 'gstack-source');
        const generated = createGstackFixture(gstackRootLexical, [
          { name: 'review', sourceLeaf: 'gstack-review' },
        ]);
        const gstackSourceLexical = path.join(generated, 'gstack-review');
        fs.writeFileSync(path.join(gstackSourceLexical, 'asset.txt'), 'asset\n', { mode: 0o644 });
        const gstackRoot = fs.realpathSync(gstackRootLexical);
        const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
        const first = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
        assert.strictEqual(first.code, 0, `${kind}:${mutation}\n${first.stderr}`);

        const ch = cursorHome(home);
        const source = kind === 'cursor-copy'
          ? path.join(repoRoot, 'active', 'skills', 'impeccable')
          : fs.realpathSync(gstackSourceLexical);
        const trigger = kind === 'cursor-copy'
          ? path.join(source, 'SKILL.md')
          : path.join(source, 'asset.txt');
        const originalSource = fs.readFileSync(trigger);
        fs.appendFileSync(trigger, `\nTRIGGER_${kind}_${mutation}\n`);
        const target = path.join(ch, 'skills', kind === 'cursor-copy' ? 'impeccable' : 'review');
        const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
        const targetBefore = snapshotTree(target);
        const manifestBefore = fs.readFileSync(manifestPath);

        const installer = path.join(repoRoot, 'scripts', kind === 'cursor-copy'
          ? 'cursor-skill-copy.mjs'
          : 'cursor-gstack-install.mjs');
        instrumentInstallerBarriers(installer);
        const installerArgs = kind === 'cursor-copy'
          ? ['sync', source, target]
          : ['skill-sync', source, target, '', gstackRoot];
        let attacked = false;
        const raced = await runInstallerAtBarrier(installer, installerArgs, (barrier, message) => {
          if (attacked || barrier !== 'before-root-chmod') return;
          attacked = true;
          if (mutation === 'source-after-digest') {
            fs.appendFileSync(trigger, '\nRACE_SOURCE\n');
          } else {
            fs.writeFileSync(path.join(message.stageLookup, 'RACE_STAGED'), 'race\n');
          }
        });
        assert.strictEqual(attacked, true, `${kind}:${mutation}: IPC barrier not reached`);
        assert.notStrictEqual(raced.code, 0, `${kind}:${mutation} must fail`);
        assert.match(raced.stderr,
          /staged (?:Cursor|gstack) skill copy differs from the validated rendered source/,
          `${kind}:${mutation}\n${raced.stderr}`);
        assert.deepStrictEqual(snapshotTree(target), targetBefore, `${kind}:${mutation}: target changed`);
        assert.deepStrictEqual(fs.readFileSync(manifestPath), manifestBefore,
          `${kind}:${mutation}: manifest changed`);
        assert.deepStrictEqual(
          fs.readdirSync(path.join(ch, 'skills'))
            .filter((entry) => /^\.jarvis-(?:cursor-stage|gstack-stage|previous|rejected)-/.test(entry)),
          [],
          `${kind}:${mutation}: transaction debris`,
        );

        fs.writeFileSync(trigger, originalSource);
        const recovered = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
        assert.strictEqual(recovered.code, 0, `${kind}:${mutation}\n${recovered.stderr}`);
        assert.strictEqual(
          fs.readFileSync(manifestPath, 'utf8').includes(
            `${kind === 'cursor-copy' ? 'impeccable' : 'review'}\t`,
          ),
          true,
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('[cursor] publish ancorado falha fechado e reverte copy presente/ausente nos dois modos', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const initialState of ['absent', 'present']) {
      const home = freshHome();
      try {
        const repoRootLexical = path.join(home, 'cortex-fixture');
        copyCortexFixture(repoRootLexical);
        const repoRoot = fs.realpathSync(repoRootLexical);
        const gstackRootLexical = path.join(home, 'gstack-source');
        const generated = createGstackFixture(gstackRootLexical, [
          { name: 'review', sourceLeaf: 'gstack-review' },
        ]);
        const gstackSource = path.join(generated, 'gstack-review');
        fs.writeFileSync(path.join(gstackSource, 'asset.txt'), 'asset\n', { mode: 0o644 });
        const gstackRoot = fs.realpathSync(gstackRootLexical);
        const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
        const ch = cursorHome(home);
        const target = path.join(ch, 'skills', kind === 'cursor-copy' ? 'impeccable' : 'review');
        const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');

        if (initialState === 'present') {
          const baseline = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
          assert.strictEqual(baseline.code, 0, `${kind}:${initialState}\n${baseline.stderr}`);
          const changedSource = kind === 'cursor-copy'
            ? path.join(repoRoot, 'active', 'skills', 'impeccable', 'SKILL.md')
            : path.join(gstackSource, 'asset.txt');
          fs.appendFileSync(changedSource, `\nPUBLISH_ROLLBACK_${kind}\n`);
        }

        const targetBefore = snapshotTree(target);
        const manifestBefore = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
        const external = path.join(home, `external-publish-${kind}-${initialState}`);
        fs.mkdirSync(external, { mode: 0o700 });
        fs.chmodSync(external, 0o700);
        fs.writeFileSync(path.join(external, 'sentinel'), 'do-not-touch\n', { mode: 0o640 });
        fs.chmodSync(path.join(external, 'sentinel'), 0o640);
        const externalBefore = snapshotTree(external);

        instrumentBootstrapBarrier(fixtureBootstrap, 'before-manifest-publish');
        const failed = await runBootstrapAtBarrier(
          home,
          { script: fixtureBootstrap, gstackRoot },
          (name) => {
            assert.strictEqual(name, 'before-manifest-publish');
            const temporary = fs.readdirSync(ch)
              .filter((entry) => entry.startsWith('.jarvis-cortex-skills.installed.'));
            assert.strictEqual(temporary.length, 1, `${kind}:${initialState}: installed manifest temp`);
            const candidate = path.join(ch, temporary[0]);
            fs.unlinkSync(candidate);
            fs.symlinkSync(external, candidate);
          },
        );
        assert.notStrictEqual(failed.code, 0, `${kind}:${initialState} publish must fail`);
        assert.match(failed.stderr, /manifest source is not private|anchored filesystem operation failed/i);
        assert.deepStrictEqual(snapshotTree(target), targetBefore,
          `${kind}:${initialState}: copy target changed after failed publish`);
        assert.deepStrictEqual(
          fs.existsSync(manifest) ? fs.readFileSync(manifest) : null,
          manifestBefore,
          `${kind}:${initialState}: managed manifest changed after failed publish`,
        );
        assert.deepStrictEqual(snapshotTree(external), externalBefore,
          `${kind}:${initialState}: external directory changed`);
        assert.deepStrictEqual(
          fs.readdirSync(path.join(ch, 'skills')).filter((entry) => /^\.jarvis-(?:cursor|gstack)-(?:stage|previous|rejected)-/.test(entry)),
          [],
          `${kind}:${initialState}: transaction debris`,
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('[cursor] mutação pós-verify falha antes do publish e restaura copy presente/ausente', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const initialState of ['absent', 'present']) {
      const home = freshHome();
      try {
        const repoRootLexical = path.join(home, 'cortex-fixture');
        copyCortexFixture(repoRootLexical);
        const repoRoot = fs.realpathSync(repoRootLexical);
        const gstackRootLexical = path.join(home, 'gstack-source');
        const generated = createGstackFixture(gstackRootLexical, [
          { name: 'review', sourceLeaf: 'gstack-review' },
        ]);
        const gstackSource = path.join(generated, 'gstack-review');
        fs.writeFileSync(path.join(gstackSource, 'asset.txt'), 'asset\n', { mode: 0o644 });
        const gstackRoot = fs.realpathSync(gstackRootLexical);
        const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
        const ch = cursorHome(home);
        const name = kind === 'cursor-copy' ? 'impeccable' : 'review';
        const target = path.join(ch, 'skills', name);
        const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');

        if (initialState === 'present') {
          const baseline = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
          assert.strictEqual(baseline.code, 0, `${kind}:${initialState}\n${baseline.stderr}`);
          fs.appendFileSync(kind === 'cursor-copy'
            ? path.join(repoRoot, 'active', 'skills', 'impeccable', 'SKILL.md')
            : path.join(gstackSource, 'asset.txt'), `\nPOST_VERIFY_SOURCE_${kind}\n`);
        }
        const targetBefore = snapshotTree(target);
        const manifestBefore = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
        instrumentBootstrapBarrier(fixtureBootstrap, 'before-terminal-publish');
        let attacked = false;
        const failed = await runBootstrapAtBarrier(home, { script: fixtureBootstrap, gstackRoot }, (barrier) => {
          assert.strictEqual(barrier, 'before-terminal-publish');
          attacked = true;
          fs.appendFileSync(path.join(target, 'SKILL.md'), '\nPOST_VERIFY_TARGET_MUTATION\n');
        });
        assert.strictEqual(attacked, true, `${kind}:${initialState}: fixture barrier`);
        assert.notStrictEqual(failed.code, 0, `${kind}:${initialState}: terminal publish must fail`);
        assert.match(failed.stderr, /transaction installed target content changed|terminal manifest publication failed/i);
        assert.deepStrictEqual(snapshotTree(target), targetBefore, `${kind}:${initialState}: copy not restored`);
        assert.deepStrictEqual(
          fs.existsSync(manifest) ? fs.readFileSync(manifest) : null,
          manifestBefore,
          `${kind}:${initialState}: manifest changed`,
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('[cursor] source attestation terminal reverte divergência pré/durante publish em ambas copies', async () => {
  for (const phase of ['prepublish', 'during-publish']) {
    for (const kind of ['cursor-copy', 'gstack-copy']) {
      for (const initialState of ['absent', 'present']) {
        const home = freshHome();
        try {
          const repoRoot = path.join(home, 'cortex-fixture');
          copyCortexFixture(repoRoot);
          const gstackRoot = path.join(home, 'gstack-source');
          const generated = createGstackFixture(gstackRoot, [{ name: 'review', sourceLeaf: 'gstack-review' }]);
          const source = kind === 'cursor-copy'
            ? path.join(repoRoot, 'active', 'skills', 'impeccable')
            : path.join(generated, 'gstack-review');
          const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
          const anchoredTool = path.join(repoRoot, 'scripts', 'cursor-anchored-fs.mjs');
          const options = { script: fixtureBootstrap, gstackRoot, anchoredTool };
          const ch = cursorHome(home);
          const target = path.join(ch, 'skills', kind === 'cursor-copy' ? 'impeccable' : 'review');
          const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');

          if (initialState === 'present') {
            const baseline = runBootstrap(home, options);
            assert.strictEqual(baseline.code, 0, `${phase}:${kind}: baseline\n${baseline.stderr}`);
            fs.appendFileSync(path.join(source, 'SKILL.md'), `\nSOURCE_UPDATE_${phase}_${kind}\n`);
          }
          const targetBefore = snapshotTree(target);
          const manifestBefore = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
          let failed;
          if (phase === 'prepublish') {
            instrumentBootstrapBarrier(fixtureBootstrap, 'source-attestation-prepublish');
            failed = await runBootstrapAtBarrier(home, options, (barrier) => {
              assert.strictEqual(barrier, 'source-attestation-prepublish');
              fs.appendFileSync(path.join(source, 'SKILL.md'), '\nSOURCE_CHANGED_AFTER_ATTESTATION\n');
            });
          } else {
            instrumentTerminalSourceMutation(anchoredTool, source);
            failed = runBootstrap(home, options);
          }
          assert.notStrictEqual(failed.code, 0, `${phase}:${kind}:${initialState}: must fail`);
          assert.match(failed.stderr,
            /attested skill source|source attestation|terminal manifest publication failed/i);
          assert.deepStrictEqual(snapshotTree(target), targetBefore,
            `${phase}:${kind}:${initialState}: target not restored`);
          assert.deepStrictEqual(
            fs.existsSync(manifest) ? fs.readFileSync(manifest) : null,
            manifestBefore,
            `${phase}:${kind}:${initialState}: manifest not restored`,
          );
          assert.deepStrictEqual(
            fs.readdirSync(path.join(ch, 'skills'))
              .filter((entry) => /^\.jarvis-(?:cursor|gstack)-(?:stage|previous|rejected)-/.test(entry)),
            [],
            `${phase}:${kind}:${initialState}: transaction debris`,
          );
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      }
    }
  }
});

test('[cursor] source de link é revalidada terminalmente antes de confirmar manifesto', () => {
  const home = freshHome();
  try {
    const repoRoot = path.join(home, 'cortex-fixture');
    copyCortexFixture(repoRoot);
    const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
    const anchoredTool = path.join(repoRoot, 'scripts', 'cursor-anchored-fs.mjs');
    const options = { script: fixtureBootstrap, anchoredTool };
    const baseline = runBootstrap(home, options);
    assert.strictEqual(baseline.code, 0, `link baseline\n${baseline.stderr}`);

    const ch = cursorHome(home);
    const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const manifestBefore = fs.readFileSync(manifest);
    const link = path.join(ch, 'skills', 'dead-code-audit');
    const linkBefore = fs.readlinkSync(link);
    const copyBefore = snapshotTree(path.join(ch, 'skills', 'impeccable'));
    const source = path.join(repoRoot, 'active', 'skills', 'dead-code-audit');

    instrumentTerminalSourceMutation(anchoredTool, source);
    const failed = runBootstrap(home, options);
    assert.notStrictEqual(failed.code, 0, 'link source mutation must fail terminal publication');
    assert.match(failed.stderr,
      /managed link source changed|installed skill changed across manifest publication|terminal manifest publication failed/i);
    assert.deepStrictEqual(fs.readFileSync(manifest), manifestBefore,
      'old manifest was not restored after link source mutation');
    assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), true);
    assert.strictEqual(fs.readlinkSync(link), linkBefore, 'managed link raw target changed');
    assert.deepStrictEqual(snapshotTree(path.join(ch, 'skills', 'impeccable')), copyBefore,
      'unrelated installed copy changed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] manifest state machine restaura old em toda transição e nunca false-green', () => {
  for (const transition of ['before-old-move', 'after-old-move', 'after-new-move', 'postverify']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
      const anchoredTool = path.join(repoRoot, 'scripts', 'cursor-anchored-fs.mjs');
      const options = { script: fixtureBootstrap, anchoredTool };
      const baseline = runBootstrap(home, options);
      assert.strictEqual(baseline.code, 0, `${transition}: baseline\n${baseline.stderr}`);
      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', 'impeccable');
      const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const targetBefore = snapshotTree(target);
      const manifestBefore = fs.readFileSync(manifest);
      fs.appendFileSync(
        path.join(repoRoot, 'active', 'skills', 'impeccable', 'SKILL.md'),
        `\nMANIFEST_TRANSITION_${transition}\n`,
      );
      instrumentTerminalPublishFailure(anchoredTool, transition);
      const failed = runBootstrap(home, options);
      assert.notStrictEqual(failed.code, 0, `${transition}: false success`);
      assert.match(failed.stderr, new RegExp(`fixture terminal failure: ${transition}`));
      assert.deepStrictEqual(fs.readFileSync(manifest), manifestBefore,
        `${transition}: old manifest content not restored`);
      assert.deepStrictEqual(snapshotTree(target), targetBefore,
        `${transition}: copy target not restored`);
      assert.deepStrictEqual(
        fs.readdirSync(ch).filter((entry) => /^\.jarvis-manifest-(?:previous|rejected)-/.test(entry)),
        [],
        `${transition}: manifest transition debris`,
      );
      assert.deepStrictEqual(
        fs.readdirSync(path.join(ch, 'skills'))
          .filter((entry) => /^\.jarvis-(?:cursor|gstack)-(?:stage|previous|rejected)-/.test(entry)),
        [],
        `${transition}: copy transaction debris`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] divergência do lookup público antes do manifesto reverte copy e preserva externo', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const initialState of ['absent', 'present']) {
      const home = freshHome();
      try {
        const repoRootLexical = path.join(home, 'cortex-fixture');
        copyCortexFixture(repoRootLexical);
        const repoRoot = fs.realpathSync(repoRootLexical);
        const gstackRootLexical = path.join(home, 'gstack-source');
        const generated = createGstackFixture(gstackRootLexical, [
          { name: 'review', sourceLeaf: 'gstack-review' },
        ]);
        const gstackSource = path.join(generated, 'gstack-review');
        fs.writeFileSync(path.join(gstackSource, 'asset.txt'), 'asset\n', { mode: 0o644 });
        const gstackRoot = fs.realpathSync(gstackRootLexical);
        const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
        const ch = cursorHome(home);
        const name = kind === 'cursor-copy' ? 'impeccable' : 'review';
        const target = path.join(ch, 'skills', name);
        const manifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');

        if (initialState === 'present') {
          const baseline = runBootstrap(home, { script: fixtureBootstrap, gstackRoot });
          assert.strictEqual(baseline.code, 0, `${kind}:${initialState}\n${baseline.stderr}`);
          fs.appendFileSync(kind === 'cursor-copy'
            ? path.join(repoRoot, 'active', 'skills', 'impeccable', 'SKILL.md')
            : path.join(gstackSource, 'asset.txt'), `\nLOOKUP_DIVERGENCE_${kind}\n`);
        }
        const targetBefore = snapshotTree(target);
        const manifestBefore = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
        const movedHome = path.join(home, 'cursor-home-original');
        const external = path.join(home, `external-cursor-home-${kind}-${initialState}`);
        fs.mkdirSync(external, { mode: 0o700 });
        fs.chmodSync(external, 0o700);
        fs.writeFileSync(path.join(external, 'sentinel'), 'do-not-touch\n', { mode: 0o640 });
        fs.chmodSync(path.join(external, 'sentinel'), 0o640);
        const externalBefore = snapshotTree(external);

        instrumentBootstrapBarrier(fixtureBootstrap, 'before-manifest-publish');
        const failed = await runBootstrapAtBarrier(
          home,
          { script: fixtureBootstrap, gstackRoot },
          (barrier) => {
            assert.strictEqual(barrier, 'before-manifest-publish');
            fs.renameSync(ch, movedHome);
            fs.symlinkSync(external, ch);
          },
        );
        assert.notStrictEqual(failed.code, 0, `${kind}:${initialState}: public lookup must fail`);
        assert.match(failed.stderr, /directory lookup changed|anchored filesystem operation failed/i);
        assert.deepStrictEqual(snapshotTree(external), externalBefore,
          `${kind}:${initialState}: external Cursor home changed`);
        assert.deepStrictEqual(snapshotTree(path.join(movedHome, 'skills', name)), targetBefore,
          `${kind}:${initialState}: copy rollback failed in moved Cursor home`);
        assert.deepStrictEqual(
          fs.existsSync(path.join(movedHome, 'jarvis-cortex-skills.manifest.tsv'))
            ? fs.readFileSync(path.join(movedHome, 'jarvis-cortex-skills.manifest.tsv'))
            : null,
          manifestBefore,
          `${kind}:${initialState}: manifest changed in moved Cursor home`,
        );
        assert.deepStrictEqual(
          fs.readdirSync(path.join(movedHome, 'skills'))
            .filter((entry) => /^\.jarvis-(?:cursor-stage|gstack-stage|previous|rejected)-/.test(entry)),
          [],
          `${kind}:${initialState}: transaction debris`,
        );
        fs.unlinkSync(ch);
        fs.renameSync(movedHome, ch);
        assert.deepStrictEqual(snapshotTree(target), targetBefore);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('[cursor] installers ancorados rejeitam swaps, mutação pós-digest e marker hardlink sem tocar externo', async () => {
  async function withInstaller(kind, initialState, attack) {
    const home = freshHome();
    try {
      const repoRootLexical = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRootLexical);
      const repoRoot = fs.realpathSync(repoRootLexical);
      const gstackRootLexical = path.join(home, 'gstack-source');
      const generated = createGstackFixture(gstackRootLexical, [
        { name: 'review', sourceLeaf: 'gstack-review' },
      ]);
      const gstackSource = path.join(generated, 'gstack-review');
      fs.writeFileSync(path.join(gstackSource, 'asset.txt'), 'asset\n', { mode: 0o644 });
      const gstackRoot = fs.realpathSync(gstackRootLexical);
      const parent = path.join(home, 'skills');
      fs.mkdirSync(parent);
      const name = kind === 'cursor-copy' ? 'impeccable' : 'review';
      const source = kind === 'cursor-copy'
        ? path.join(repoRoot, 'active', 'skills', 'impeccable')
        : fs.realpathSync(gstackSource);
      const target = path.join(parent, name);
      const tool = path.join(repoRoot, 'scripts', kind === 'cursor-copy'
        ? 'cursor-skill-copy.mjs'
        : 'cursor-gstack-install.mjs');
      const args = kind === 'cursor-copy'
        ? ['sync', source, target]
        : ['skill-sync', source, target, '', gstackRoot];
      if (initialState === 'present') {
        const installed = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
        assert.strictEqual(installed.status, 0, `${kind}:${attack}: baseline\n${installed.stderr}`);
      }
      instrumentInstallerBarriers(tool);
      const targetBefore = snapshotTree(target);
      const dummyManifest = path.join(home, 'manifest.tsv');
      fs.writeFileSync(dummyManifest, 'unchanged\n', { mode: 0o600 });
      const manifestBefore = snapshotTree(dummyManifest);
      let cleanupAttack = () => {};
      let attacked = false;

      const failed = await runInstallerAtBarrier(tool, args, (barrier, message) => {
        if (attacked) return;
        if (attack === 'parent-swap' && barrier === 'before-commit') {
          attacked = true;
          const savedParent = path.join(home, 'skills-original');
          const external = path.join(home, 'external-skills');
          fs.mkdirSync(external, { mode: 0o700 });
          fs.chmodSync(external, 0o700);
          fs.mkdirSync(path.join(external, name), { mode: 0o711 });
          fs.writeFileSync(path.join(external, name, 'sentinel'), 'external\n', { mode: 0o640 });
          fs.chmodSync(path.join(external, name, 'sentinel'), 0o640);
          const externalBefore = snapshotTree(external);
          fs.renameSync(message.parentLookup, savedParent);
          fs.symlinkSync(external, message.parentLookup);
          cleanupAttack = () => {
            assert.deepStrictEqual(snapshotTree(external), externalBefore,
              `${kind}:${initialState}: external target changed`);
            assert.deepStrictEqual(snapshotTree(path.join(savedParent, name)), targetBefore,
              `${kind}:${initialState}: original target changed`);
            assert.deepStrictEqual(
              fs.readdirSync(savedParent).filter((entry) => /^\.jarvis-(?:cursor-stage|gstack-stage|previous|rejected)-/.test(entry)),
              [],
              `${kind}:${initialState}: transaction debris in moved parent`,
            );
            fs.unlinkSync(message.parentLookup);
            fs.renameSync(savedParent, message.parentLookup);
          };
          return;
        }
        if (attack === 'stage-symlink' && barrier === 'before-root-chmod') {
          attacked = true;
          const savedStage = path.join(home, `saved-stage-${kind}`);
          const external = path.join(home, `external-stage-${kind}`);
          fs.mkdirSync(external, { mode: 0o700 });
          fs.chmodSync(external, 0o700);
          fs.writeFileSync(path.join(external, 'sentinel'), 'external\n', { mode: 0o640 });
          fs.chmodSync(path.join(external, 'sentinel'), 0o640);
          const externalBefore = snapshotTree(external);
          fs.renameSync(message.stageLookup, savedStage);
          fs.symlinkSync(external, message.stageLookup);
          cleanupAttack = () => {
            assert.deepStrictEqual(snapshotTree(external), externalBefore,
              `${kind}: stage symlink external changed`);
            assert.strictEqual(fs.lstatSync(message.stageLookup, { throwIfNoEntry: false }), undefined,
              `${kind}: replacement stage symlink was not cleaned`);
            fs.rmSync(savedStage, { recursive: true, force: true });
          };
          return;
        }
        if (attack === 'staged-mutation' && barrier === 'before-marker') {
          attacked = true;
          fs.appendFileSync(path.join(message.stageLookup, 'SKILL.md'), '\nPOST_DIGEST_MUTATION\n');
          return;
        }
        if (attack === 'marker-hardlink' && barrier === 'before-marker') {
          attacked = true;
          const external = path.join(home, `external-marker-${kind}`);
          fs.writeFileSync(external, 'external-marker\n', { mode: 0o640 });
          fs.chmodSync(external, 0o640);
          const externalBefore = snapshotTree(external);
          fs.linkSync(external, path.join(message.stageLookup, '.jarvis-cortex-skill.json'));
          cleanupAttack = () => {
            assert.deepStrictEqual(snapshotTree(external), externalBefore,
              `${kind}: marker hardlink external changed`);
            assert.strictEqual(fs.lstatSync(external).nlink, 1, `${kind}: marker hardlink leaked`);
          };
        }
      });

      assert.strictEqual(attacked, true, `${kind}:${initialState}:${attack}: barrier not reached`);
      assert.notStrictEqual(failed.code, 0, `${kind}:${initialState}:${attack} must fail`);
      cleanupAttack();
      assert.deepStrictEqual(snapshotTree(target), targetBefore,
        `${kind}:${initialState}:${attack}: target changed`);
      assert.deepStrictEqual(snapshotTree(dummyManifest), manifestBefore,
        `${kind}:${initialState}:${attack}: manifest changed`);
      assert.deepStrictEqual(
        fs.readdirSync(parent).filter((entry) => /^\.jarvis-(?:cursor-stage|gstack-stage|previous|rejected)-/.test(entry)),
        [],
        `${kind}:${initialState}:${attack}: transaction debris`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const initialState of ['absent', 'present']) {
      await withInstaller(kind, initialState, 'parent-swap');
    }
    for (const attack of ['staged-mutation', 'stage-symlink', 'marker-hardlink']) {
      await withInstaller(kind, 'present', attack);
    }
  }
});

test('[cursor] previous divergente nunca é restaurado por cursor-copy/gstack-copy presente ou ausente', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    for (const initialState of ['present', 'absent']) {
      const home = freshHome();
      try {
        const repoRootLexical = path.join(home, 'cortex-fixture');
        copyCortexFixture(repoRootLexical);
        const repoRoot = fs.realpathSync(repoRootLexical);
        const gstackRootLexical = path.join(home, 'gstack-source');
        const generated = createGstackFixture(gstackRootLexical, [
          { name: 'review', sourceLeaf: 'gstack-review' },
        ]);
        const gstackRoot = fs.realpathSync(gstackRootLexical);
        const source = kind === 'cursor-copy'
          ? path.join(repoRoot, 'active', 'skills', 'impeccable')
          : fs.realpathSync(path.join(generated, 'gstack-review'));
        const parent = path.join(home, 'skills');
        fs.mkdirSync(parent);
        const target = path.join(parent, kind === 'cursor-copy' ? 'impeccable' : 'review');
        const tool = path.join(repoRoot, 'scripts', kind === 'cursor-copy'
          ? 'cursor-skill-copy.mjs'
          : 'cursor-gstack-install.mjs');
        const args = kind === 'cursor-copy'
          ? ['sync', source, target]
          : ['skill-sync', source, target, '', gstackRoot];
        if (initialState === 'present') {
          const baseline = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
          assert.strictEqual(baseline.status, 0, `${kind}: baseline ${baseline.stderr}`);
        }
        instrumentInstallerBarriers(tool);
        const external = path.join(home, `external-previous-${kind}-${initialState}`);
        fs.mkdirSync(external, { mode: 0o711 });
        fs.writeFileSync(path.join(external, 'sentinel'), 'EXTERNAL_SAFE\n', { mode: 0o640 });
        fs.chmodSync(path.join(external, 'sentinel'), 0o640);
        const externalBefore = snapshotTree(external);
        let attacked = false;
        const failed = await runInstallerAtBarrier(tool, args, (barrier, message) => {
          if (barrier !== 'after-commit' || attacked) return;
          attacked = true;
          const token = JSON.parse(Buffer.from(message.transactionToken, 'base64url').toString('utf8'));
          assert.strictEqual(token.version, 3, `${kind}: transaction token version`);
          assert.strictEqual(token.sourceAttestation?.sourcePath, source,
            `${kind}: source attestation is embedded in transaction`);
          assert.ok(token.sourceAttestation?.sourceRecord?.fingerprint,
            `${kind}: transaction source fingerprint`);
          assert.ok(token.sourceAttestation?.sourceCanonicalDigest,
            `${kind}: transaction source canonical digest`);
          if (initialState === 'present') {
            assert.ok(token.previousName, `${kind}: previous token`);
            const previous = path.join(message.parentLookup, token.previousName);
            fs.rmSync(previous, { recursive: true });
            fs.symlinkSync(external, previous);
            const anchoredTool = path.join(repoRoot, 'scripts', 'cursor-anchored-fs.mjs');
            for (const operation of ['assert-transaction', 'rollback', 'finalize']) {
              const rejected = spawnSync(process.execPath, [
                anchoredTool, operation, message.transactionToken,
              ], { encoding: 'utf8' });
              assert.notStrictEqual(rejected.status, 0, `${kind}:${operation}: must fail closed`);
              assert.strictEqual(fs.lstatSync(previous).isSymbolicLink(), true,
                `${kind}:${operation}: divergent artifact type changed`);
              assert.strictEqual(fs.readlinkSync(previous), external,
                `${kind}:${operation}: divergent artifact raw link changed`);
              assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), false,
                `${kind}:${operation}: public target became a symlink`);
              assert.deepStrictEqual(snapshotTree(external), externalBefore,
                `${kind}:${operation}: external changed`);
            }
          } else {
            assert.strictEqual(token.previousName, null);
            fs.appendFileSync(path.join(message.parentLookup, message.targetName, 'SKILL.md'), '\nTAMPER\n');
          }
        });
        assert.strictEqual(attacked, true, `${kind}:${initialState}: after-commit barrier`);
        assert.notStrictEqual(failed.code, 0, `${kind}:${initialState}: must fail closed`);
        assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || false, false);
        assert.deepStrictEqual(snapshotTree(external), externalBefore, `${kind}:${initialState}: external changed`);
        const previousDebris = fs.readdirSync(parent)
          .filter((entry) => entry.startsWith('.jarvis-previous-'));
        if (initialState === 'present') {
          assert.strictEqual(previousDebris.length, 1,
            `${kind}: divergent previous must remain quarantined`);
          const preserved = path.join(parent, previousDebris[0]);
          assert.strictEqual(fs.lstatSync(preserved).isSymbolicLink(), true);
          assert.strictEqual(fs.readlinkSync(preserved), external);
        } else {
          assert.deepStrictEqual(previousDebris, []);
          assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('[cursor] Impeccable migra symlink legacy Jarvis sem manifesto para cópia renderizada', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'impeccable');
    const managedManifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'active', 'claude-skills', 'impeccable'), target);
    assert.strictEqual(fs.existsSync(managedManifest), false, 'fixture deve simular instalação sem manifesto');

    const result = runBootstrap(home);
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), false);
    assert.ok(fs.existsSync(path.join(target, '.jarvis-cortex-skill.json')));
    assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /CURSOR_HOME:-\$HOME\/\.cursor/);
    assert.match(fs.readFileSync(managedManifest, 'utf8'), /^impeccable\t.*\tcursor-copy\tcortex$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] Impeccable preserva symlink custom sem manifesto', () => {
  const home = freshHome();
  try {
    const custom = path.join(home, 'custom-impeccable');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: impeccable\ndescription: user owned\n---\n');
    const target = path.join(cursorHome(home), 'skills', 'impeccable');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(custom, target);

    const result = runBootstrap(home);
    assert.strictEqual(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /not a Jarvis-managed symlink; preserving it/);
    assert.strictEqual(fs.realpathSync(target), fs.realpathSync(custom));
    assert.doesNotMatch(
      fs.readFileSync(path.join(cursorHome(home), 'jarvis-cortex-skills.manifest.tsv'), 'utf8'),
      /^impeccable\t/m,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] Impeccable preserva cursor-copy com marker de outra proveniência', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'impeccable');
    const markerPath = path.join(target, '.jarvis-cortex-skill.json');
    const otherSource = path.join(home, 'other-impeccable-source');
    fs.mkdirSync(otherSource);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.sourcePath = otherSource;
    marker.sourceReal = fs.realpathSync(otherSource);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'CROSS_PROVENANCE_USER_CONTENT\n');

    const rerun = runBootstrap(home);
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.match(rerun.stderr, /marker with unexpected source identity; preserving it/);
    assert.strictEqual(
      fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'),
      'CROSS_PROVENANCE_USER_CONTENT\n',
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(ch, 'jarvis-cortex-skills.manifest.tsv'), 'utf8'),
      /^impeccable\t/m,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] Impeccable aceita relocação somente via previous_source exato', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const ch = cursorHome(home);
    const target = path.join(ch, 'skills', 'impeccable');
    const markerPath = path.join(target, '.jarvis-cortex-skill.json');
    const managedManifest = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
    const oldCortex = path.join(home, 'old-cortex');
    copyCortexFixture(oldCortex);
    const previousSource = path.join(
      fs.realpathSync(oldCortex),
      'active',
      'skills',
      'impeccable',
    );

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.sourcePath = previousSource;
    marker.sourceReal = fs.realpathSync(previousSource);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    fs.appendFileSync(path.join(target, 'SKILL.md'), '\nRELOCATION_SENTINEL\n');
    const previousManifest = fs.readFileSync(managedManifest, 'utf8').split('\n').map((line) => {
      const fields = line.split('\t');
      if (fields[0] === 'impeccable') fields[1] = previousSource;
      return fields.join('\t');
    }).join('\n');
    fs.writeFileSync(managedManifest, previousManifest);

    const rerun = runBootstrap(home);
    assert.strictEqual(rerun.code, 0, `${rerun.stderr}\n${rerun.stdout}`);
    assert.doesNotMatch(rerun.stderr, /unexpected source identity/);
    assert.doesNotMatch(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /RELOCATION_SENTINEL/);
    const repairedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const currentSource = path.join(REPO_ROOT, 'active', 'skills', 'impeccable');
    assert.strictEqual(repairedMarker.sourcePath, currentSource);
    assert.strictEqual(repairedMarker.sourceReal, fs.realpathSync(currentSource));
    assert.match(fs.readFileSync(managedManifest, 'utf8'), new RegExp(
      `^impeccable\\t${currentSource.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\tcursor-copy\\tcortex$`,
      'm',
    ));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] relocation cursor-copy inválida preserva target e manifesto anteriores', () => {
  for (const variant of ['nested-symlink', 'nested-invalid-type']) {
    const home = freshHome();
    try {
      const oldCortex = path.join(home, 'old-cortex');
      copyCortexFixture(oldCortex);
      const oldBootstrap = path.join(oldCortex, 'scripts', 'bootstrap-cursor.sh');
      const installed = runBootstrap(home, { script: oldBootstrap });
      assert.strictEqual(installed.code, 0, `${variant}\n${installed.stderr}\n${installed.stdout}`);

      const ch = cursorHome(home);
      const target = path.join(ch, 'skills', 'impeccable');
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      const newCortex = path.join(home, 'new-cortex');
      copyCortexFixture(newCortex);
      const newBootstrap = path.join(newCortex, 'scripts', 'bootstrap-cursor.sh');
      for (const [destination, source] of [
        ['hooks/rtk-shell.js', 'cursor/hooks/rtk-shell.js'],
        ['hooks/enforce-cursor.js', 'cursor/hooks/enforce-cursor.js'],
        ['hooks/session-start.js', 'cursor/hooks/session-start.js'],
        ['permissions.json', 'cursor/permissions.json'],
        ['rules/jarvis-cortex.mdc', 'cursor/rules/jarvis-cortex.mdc'],
      ]) {
        const installedLink = path.join(ch, destination);
        fs.unlinkSync(installedLink);
        fs.symlinkSync(fs.realpathSync(path.join(newCortex, source)), installedLink);
      }
      const targetBefore = snapshotTree(target);
      const manifestBefore = fs.readFileSync(manifestPath);

      const nested = path.join(newCortex, 'active', 'skills', 'impeccable', 'reference', 'adapt.md');
      fs.unlinkSync(nested);
      if (variant === 'nested-symlink') {
        const external = path.join(home, 'external-adapt.md');
        fs.writeFileSync(external, '# external\n');
        fs.symlinkSync(external, nested);
      } else {
        const fifo = spawnSync('mkfifo', [nested], { encoding: 'utf8' });
        assert.strictEqual(fifo.status, 0, fifo.stderr);
      }

      const rejected = runBootstrap(home, { script: newBootstrap });
      assert.notStrictEqual(rejected.code, 0, `${variant}: bootstrap deveria rejeitar source inválida`);
      if (variant === 'nested-symlink') {
        assert.match(rejected.stderr, /contains a symlink/, rejected.stderr);
      } else {
        assert.match(rejected.stderr, /FIFO|fifo|unsupported|operation not supported/i, rejected.stderr);
      }
      assert.deepStrictEqual(snapshotTree(target), targetBefore, `${variant}: target foi alterado`);
      assert.deepStrictEqual(fs.readFileSync(manifestPath), manifestBefore, `${variant}: manifesto foi alterado`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] cleanup pós-commit não quebra cursor-copy/gstack-copy nem deixa temp indexável', async () => {
  for (const kind of ['cursor-copy', 'gstack-copy']) {
    const home = freshHome();
    try {
      const repoRoot = path.join(home, 'cortex-fixture');
      copyCortexFixture(repoRoot);
      const fixtureBootstrap = path.join(repoRoot, 'scripts', 'bootstrap-cursor.sh');
      const gstackRoot = path.join(home, 'gstack-source');
      if (kind === 'gstack-copy') createGstackFixture(gstackRoot, ['gstack-review']);
      const options = { script: fixtureBootstrap, gstackRoot };
      const installed = runBootstrap(home, options);
      assert.strictEqual(installed.code, 0, `${kind}\n${installed.stderr}\n${installed.stdout}`);

      const ch = cursorHome(home);
      const name = kind === 'cursor-copy' ? 'impeccable' : 'gstack-review';
      const target = path.join(ch, 'skills', name);
      const changedSource = kind === 'cursor-copy'
        ? path.join(repoRoot, 'active', 'skills', 'impeccable', 'reference', 'adapt.md')
        : path.join(gstackRoot, '.cursor', 'skills', 'gstack-review', 'SKILL.md');
      fs.appendFileSync(changedSource, `\nPOST_COMMIT_${kind}\n`);

      const anchoredTool = path.join(repoRoot, 'scripts', 'cursor-anchored-fs.mjs');
      const anchoredSource = fs.readFileSync(anchoredTool, 'utf8');
      const cleanupNeedle = '      fs.rmSync(cleanupName, { recursive: true, force: true });';
      assert.strictEqual(anchoredSource.split(cleanupNeedle).length, 2, `${kind}: cleanup needle`);
      fs.writeFileSync(
        anchoredTool,
        anchoredSource.replace(cleanupNeedle, "      throw new Error('injected fixture cleanup failure');"),
      );
      const committed = runBootstrap(home, options);
      assert.strictEqual(committed.code, 0, `${kind}\n${committed.stderr}\n${committed.stdout}`);
      assert.match(committed.stderr, /committed; transaction cleanup failed outside Cursor skills: injected fixture cleanup failure/);
      assert.match(fs.readFileSync(path.join(target, kind === 'cursor-copy' ? 'reference/adapt.md' : 'SKILL.md'), 'utf8'),
        new RegExp(`POST_COMMIT_${kind}`));
      const manifestPath = path.join(ch, 'jarvis-cortex-skills.manifest.tsv');
      assert.match(fs.readFileSync(manifestPath, 'utf8'), new RegExp(`^${name}\\t.*\\t${kind}\\t`, 'm'));
      assert.deepStrictEqual(
        fs.readdirSync(path.join(ch, 'skills'))
          .filter((entry) => /^\.jarvis-(?:cursor-stage|gstack-stage|previous|rejected)-/.test(entry)),
        [],
        `${kind}: transaction temp must stay outside the indexable skills root`,
      );
      assert.strictEqual(
        fs.readdirSync(ch).filter((entry) => entry.startsWith('.jarvis-copy-cleanup-')).length,
        1,
        `${kind}: injected cleanup failure must leave only one non-indexable recovery directory`,
      );

      const targetAfterCommit = snapshotTree(target);
      const manifestAfterCommit = fs.readFileSync(manifestPath);
      const rerun = runBootstrap(home, options);
      assert.strictEqual(rerun.code, 0, `${kind}/rerun\n${rerun.stderr}\n${rerun.stdout}`);
      assert.deepStrictEqual(snapshotTree(target), targetAfterCommit, `${kind}: rerun changed committed target`);
      assert.deepStrictEqual(fs.readFileSync(manifestPath), manifestAfterCommit, `${kind}: rerun changed manifest`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('[cursor] bootstrap torna explícito quando importação third-party não está desligada', () => {
  const home = freshHome();
  try {
    const r = runBootstrap(home, { thirdParty: 'true' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /third-party imports are not proven disabled \(on\).*Doctor will FAIL/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] env third-party legado é inerte com DB inexistente em bootstrap e doctor', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    const missingDb = path.join(home, 'does-not-exist', 'state.vscdb');
    const legacyEnvironment = {
      ...process.env,
      ...cursorFixtureEnv(home, { cursorHome: ch }),
      JARVIS_BRAIN_OPTIONAL: '1',
      JARVIS_TEST_CURSOR_THIRD_PARTY_EXTENSIBILITY: 'false',
      CURSOR_STATE_DB: missingDb,
      PATH: process.env.PATH,
    };
    const installed = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 30000,
      env: legacyEnvironment,
    });
    assert.strictEqual(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);
    assert.doesNotMatch(installed.stdout, /third-party imports: verified disabled/i);
    assert.match(installed.stderr, /not proven disabled \((?:missing-db|no-sqlite)\)/);

    const doctor = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'doctor.sh')], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...legacyEnvironment,
        CLAUDE_HOME: path.join(home, '.claude-absent'),
        CODEX_HOME: path.join(home, '.codex-absent'),
        AGENTS_TARGET_SKILLS: path.join(home, '.agents', 'skills'),
      },
    });
    assert.notStrictEqual(doctor.status, 0, doctor.stdout);
    assert.match(doctor.stdout,
      /FAIL\s+Cursor third-party imports are not proven disabled \((?:missing-db|no-sqlite)\)/);
    assert.doesNotMatch(doctor.stdout, /OK\s+Cursor third-party imports are explicitly disabled/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] falha interna do instalador de skill é propagada', () => {
  const home = freshHome();
  try {
    const failingTool = path.join(home, 'failing-copy-tool.mjs');
    fs.writeFileSync(failingTool, 'process.stderr.write("injected copy failure\\n"); process.exit(42);\n');
    const r = runBootstrap(home, { copyTool: failingTool });
    assert.strictEqual(r.code, 42, `${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /injected copy failure/);
    assert.doesNotMatch(r.stdout, /Cursor bootstrap complete/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] merge idempotente e preserva MCP manual', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    fs.mkdirSync(ch, { recursive: true });
    fs.writeFileSync(path.join(ch, 'mcp.json'), JSON.stringify({
      mcpServers: {
        custom: { command: 'echo', args: ['hi'] },
      },
    }, null, 2));

    assert.strictEqual(runBootstrap(home).code, 0);
    assert.strictEqual(runBootstrap(home).code, 0);

    const mcp = JSON.parse(fs.readFileSync(path.join(ch, 'mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.custom, 'MCP manual deve sobreviver');
    assert.ok(mcp.mcpServers['graphify-brain'], 'graphify-brain deve ser injetado');

    const hooksRaw = fs.readFileSync(path.join(ch, 'hooks.json'), 'utf8');
    const count = hooksRaw.split('./hooks/rtk-shell.js').length - 1;
    assert.strictEqual(count, 1, 'rtk-shell não deve duplicar no re-run');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] managed mcp key customizado → warn + backup antes de sobrescrever', () => {
  const home = freshHome();
  try {
    const ch = cursorHome(home);
    fs.mkdirSync(ch, { recursive: true });
    fs.writeFileSync(path.join(ch, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'graphify-brain': { command: 'custom-bin', args: ['--x'] },
      },
    }, null, 2));

    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stderr, /overwriting customized mcpServers\.graphify-brain/, r.stderr);
    const backups = fs.readdirSync(ch).filter((f) => f.includes('managed-graphify-brain.backup'));
    assert.ok(backups.length >= 1, 'deve criar backup do managed key');
    const mcp = JSON.parse(fs.readFileSync(path.join(ch, 'mcp.json'), 'utf8'));
    assert.notStrictEqual(mcp.mcpServers['graphify-brain'].command, 'custom-bin');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[cursor] enforce entries são fail-open e Shell só em beforeShellExecution', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const hooks = JSON.parse(fs.readFileSync(path.join(cursorHome(home), 'hooks.json'), 'utf8'));
    const pre = hooks.hooks.preToolUse || [];
    const enforcePre = pre.find((h) => h.command === './hooks/enforce-cursor.js');
    assert.ok(enforcePre);
    assert.strictEqual(enforcePre.failClosed, undefined);
    assert.doesNotMatch(enforcePre.matcher || '', /Shell/);
    const before = hooks.hooks.beforeShellExecution || [];
    const enforceShell = before.find((h) => h.command === './hooks/enforce-cursor.js');
    assert.ok(enforceShell);
    assert.strictEqual(enforceShell.failClosed, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('[cursor] rule documenta skills nativas e exclui imports Claude/Codex third-party', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const rule = path.join(cursorHome(home), 'rules', 'jarvis-cortex.mdc');
    assert.ok(fs.existsSync(rule));
    assert.ok(fs.lstatSync(rule).isSymbolicLink());
    const documented = fs.readFileSync(rule, 'utf8');
    assert.ok(documented.includes('`${CURSOR_HOME:-$HOME/.cursor}/skills`'));
    assert.ok(documented.includes('por padrão, `~/.cursor/skills`'));
    assert.ok(documented.includes('Não carregue skills pelos caminhos third-party `~/.claude/skills` ou `~/.codex/skills`'));
    assert.doesNotMatch(documented, /Skills do cortex: via `~\/\.claude\/skills`/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
