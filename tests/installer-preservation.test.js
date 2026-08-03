#!/usr/bin/env node
/**
 * tests/installer-preservation.test.js — regressão da máquina de preservação
 * dos instaladores (scripts/install-codex-skills.sh, scripts/bootstrap-claude.sh).
 *
 * O defeito original: os instaladores DESTRUÍAM dado do usuário. `rm -rf` em
 * qualquer ~/.codex/skills/<name> que colidisse com um dos nomes vendorados
 * (nomes genéricos: review, qa, ship, learn, pdf) e `rm -f` em qualquer symlink
 * pré-existente sem olhar pra onde apontava.
 *
 * O redesign tem UM invariante, e é ele que esta suíte trava:
 *
 *     Nenhum branch remove um path que ele não criou nesta run.
 *
 * Substituição agora é: reservar um slot exclusivo via `mktemp -d`, PARKAR a
 * árvore existente lá dentro, e só então mover a cópia staged pro lugar. O
 * digest de conteúdo continua existindo mas NÃO é mais fronteira de segurança —
 * ele decide só se a run fica quieta ou diz "backed up". Os testes D1/D2 abaixo
 * são a prova de carga disso: com o digest errado nas duas direções, nada some.
 *
 * Contagens são DERIVADAS do repo (ver DERIVED_*), nunca hardcoded: adicionar um
 * dir em codex/skills-local/ não pode quebrar um teste de preservação. O que
 * fica pinado é a FORMA ("Installed <n>"), não o número.
 *
 * Cada teste é hermético: HOME temp, CODEX_HOME/CLAUDE_HOME dentro dele, sem
 * rede (INSTALL_GSTACK/INSTALL_KARPATHY/INSTALL_MATTPOCOCK/SETUP_GRAPHIFY_BRAIN
 * desligados), limpo no finally. Alvos "estrangeiros" são arquivos criados no
 * próprio HOME temp, não /etc/hosts, pra não depender da máquina real.
 *
 * Run: node --test tests/installer-preservation.test.js   (~50s isolado)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CODEX_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-codex-skills.sh');
const CLAUDE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-claude.sh');
const CODEX_BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-codex.sh');

// Espelha PROMOTED_CORTEX_SKILLS em install-codex-skills.sh. Hardcoded de
// propósito (mesma razão de tests/hm-skills.test.js): derivar a lista do mesmo
// lugar que o script usa faria uma remoção sumir dos dois lados em silêncio.
const PROMOTED_CORTEX_SKILLS = [
  'dead-code-audit', 'impeccable', 'jarvis-learn', 'loop-hermes',
  'orchestrate', 'security-audit', 'strategic-compact', 'verification-loop',
];
// Nomes que o loop de instalação pula (install-codex-skills.sh).
const NON_SKILL_ENTRIES = new Set(['.system', 'gstack', 'codex-primary-runtime', 'napkin']);

// Quantas skills o instalador deve reportar. Derivado da mesma regra que o
// script aplica, então adicionar/remover uma skill vendorada move os dois lados
// juntos e este teste continua falando só sobre preservação.
function derivedInstall() {
  const sourceSkills = path.join(REPO_ROOT, 'codex', 'skills-local');
  const hasPromotedSource = (name) => fs.existsSync(path.join(REPO_ROOT, 'active', 'skills', name));
  const names = [];
  for (const name of fs.readdirSync(sourceSkills)) {
    if (name.startsWith('.')) continue; // o glob do shell não pega dotfiles
    if (!fs.statSync(path.join(sourceSkills, name)).isDirectory()) continue;
    if (NON_SKILL_ENTRIES.has(name)) continue;
    if (PROMOTED_CORTEX_SKILLS.includes(name) && hasPromotedSource(name)) continue;
    names.push(name);
  }
  names.sort();
  return {
    names,
    installed: names.length,
    promoted: PROMOTED_CORTEX_SKILLS.filter(hasPromotedSource).length,
  };
}
const DERIVED = derivedInstall();

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-installer-'));
}

function rmHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

// Cópia descartável do checkout, usada por todo teste que exercita um caminho
// capaz de ESCREVER na própria árvore fonte. Rodar esses casos contra o checkout
// real já custou caro: uma versão quebrada truncou cursor/hooks/rtk-shell.js e
// outra espalhou 13 arquivos por active/, commands/, docs/, memory/ e scripts/.
// Contra a cópia, uma versão quebrada espalha o que quiser — a cópia é jogada
// fora no finally e o checkout nunca é destino de escrita nenhuma. É por isso
// que este arquivo NÃO tem caminho de remoção: não existe lixo pra limpar.
//
// `realpathSync` no destino é obrigatório: bootstrap-claude.sh resolve seu root
// com `cd --` (lógico) e bootstrap-codex.sh com `cd -P` (físico). Em macOS o
// mkdtemp devolve /var/folders/... (symlink pra /private/var/...), então sem
// realpath os dois scripts derivariam grafias DIFERENTES do mesmo root e as
// asserções de "link aponta pra grafia canônica" ficariam vermelhas por
// plataforma, não por defeito.
//
// Sem `.git`: 21MB e ~420ms por cópia, e nenhum teste aqui olha pro histórico.
// (Auditado: o checkout não contém symlink nenhum — `find . -type l` = 0 — logo
// a cópia é auto-contida e não referencia o original por acidente.)
function copyCheckout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cortex-copy-')));
  fs.cpSync(REPO_ROOT, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REPO_ROOT, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`);
    },
  });
  return root;
}

// Conjunto de entradas de uma árvore inteira: path relativo -> tipo, modo e
// tamanho. Sem conteúdo, então é barato o bastante pra rodar sobre o checkout
// copiado inteiro — o que transforma "espalhou arquivo em algum lugar do repo"
// (o incidente dos 13 arquivos) em uma asserção só. O digest byte-a-byte
// (treeDigest) continua existindo pro subconjunto que importa.
function entrySet(root) {
  const entries = new Map();
  const walk = (current, relative) => {
    const stat = fs.lstatSync(current);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) { entries.set(relative, `link:${mode}`); return; }
    if (stat.isDirectory()) {
      entries.set(relative, `dir:${mode}`);
      for (const entry of fs.readdirSync(current).sort()) {
        walk(path.join(current, entry), relative ? path.join(relative, entry) : entry);
      }
      return;
    }
    entries.set(relative, `file:${mode}:${stat.size}`);
  };
  walk(root, '');
  return entries;
}

function diffSets(before, after) {
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    changed: [...before.keys()]
      .filter((key) => after.has(key) && after.get(key) !== before.get(key)).sort(),
  };
}

// TODA variável que estes scripts leem e que pode redirecionar uma ESCRITA fica
// pinada dentro do HOME temp. Só espalhar `...process.env` não basta: um
// CLAUDE_BACKUP_DIR ou GSTACK_BACKUP_DIR presente no ambiente do dev faria os
// backups caírem FORA do fixture — sobrevivendo ao rmHome e escrevendo em
// diretório real. Auditado com:
//   grep -oE '\$\{[A-Z_]+:?-?' scripts/{install-codex-skills,bootstrap-claude,
//     bootstrap-codex,install-mattpocock-skills,setup-graphify-brain,
//     update-karpathy-skills}.sh
// Os gates (INSTALL_*/SETUP_*) desligam os passos de rede; os *_DIR/_TARGET/
// _CACHE/_HOME abaixo garantem que, mesmo se um gate for ligado por engano, o
// destino continua dentro do fixture.
function fixtureEnv(home) {
  return {
    HOME: home,
    // codex
    CODEX_HOME: path.join(home, '.codex'),
    CODEX_BACKUP_DIR: path.join(home, '.codex', 'backups'),
    GSTACK_BACKUP_DIR: path.join(home, '.codex', 'backups', 'skills'),
    GSTACK_MIGRATED_DIR: path.join(home, '.gstack', 'repos', 'gstack'),
    AGENTS_TARGET_SKILLS: path.join(home, '.agents', 'skills'),
    INSTALL_GSTACK: '0',
    INSTALL_KARPATHY: '0',
    // claude
    CLAUDE_HOME: path.join(home, '.claude'),
    CLAUDE_BACKUP_DIR: path.join(home, '.claude', 'backups'),
    // externos opcionais (desligados, e ainda assim redirecionados pro fixture)
    INSTALL_MATTPOCOCK: '0',
    MATTPOCOCK_TARGET: path.join(home, '.mattpocock-target'),
    MATTPOCOCK_CACHE: path.join(home, '.mattpocock-cache'),
    SETUP_GRAPHIFY_BRAIN: '0',
    JARVIS_BRAIN_HOME: path.join(home, '.jarvis-brain-absent'),
    JARVIS_CORTEX_CONFIG: path.join(home, '.jarvis-cortex-config.json'),
  };
}

function runScript(script, home, opts = {}) {
  const r = spawnSync('bash', [opts.script || script], {
    encoding: 'utf8',
    timeout: 120000,
    // `cwd` acompanha o script: rodar uma CÓPIA do checkout com o cwd apontando
    // pro checkout real faria qualquer path relativo escapar da cópia.
    cwd: opts.cwd || REPO_ROOT,
    env: {
      ...process.env,
      ...fixtureEnv(home),
      ...(opts.path ? { PATH: opts.path } : {}),
      ...(opts.env || {}),
    },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const runCodex = (home, opts = {}) => runScript(CODEX_SCRIPT, home, opts);
const runClaude = (home, opts = {}) => runScript(CLAUDE_SCRIPT, home, opts);

// bootstrap-codex.sh aborta cedo sem o CLI `codex` e sem o probe de contrato do
// RTK. Os dois são shimados de forma hermética (nada de rede, nada de binário
// real): `codex features list` anuncia hooks=true e `rtk hook claude` devolve a
// reescrita que verify-rtk-codex-hook.sh exige. É shim de DEPENDÊNCIA externa,
// não do código sob teste — link_file/backup_target rodam íntegros.
function codexCliPath(home) {
  const bin = path.join(home, 'codex-cli-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'),
    '#!/bin/sh\ncase "$1" in features) echo "hooks   enabled   true" ;; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rtk'), `#!/bin/sh
case "$1" in
  --version) echo "rtk 0.43.0"; exit 0 ;;
  hook) cat >/dev/null; printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}'; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  for (const name of ['codex', 'rtk']) fs.chmodSync(path.join(bin, name), 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

function runCodexBootstrap(home, opts = {}) {
  return runScript(CODEX_BOOTSTRAP_SCRIPT, home, { path: codexCliPath(home), ...opts });
}

const codexBackups = (home) => path.join(home, '.codex', 'backups', 'skills');
const claudeBackups = (home) => path.join(home, '.claude', 'backups');
const stagingParent = (home) => path.join(home, '.codex', '.cortex-staging');

// Run dirs de staging pendentes. O pai persiste entre runs; cada run apaga o
// SEU no trap EXIT. Um run dir sobrando = alguma run morreu sem trap (SIGKILL).
function stagingRuns(home) {
  const parent = stagingParent(home);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((entry) => entry.startsWith('run.')).sort();
}

function backupSlots(backupDir, base) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((entry) => entry.startsWith(`${base}.backup.`)).sort();
}

// Exatamente UM slot, não "pelo menos um": duas cópias parkadas por engano
// passariam num teste que só checa presença, escondendo um bug de reserva.
function soleBackupSlot(backupDir, base) {
  const slots = backupSlots(backupDir, base);
  assert.strictEqual(slots.length, 1,
    `esperava exatamente 1 slot ${base}.backup.*, achei ${slots.length}: ${slots.join(', ')}`);
  return path.join(backupDir, slots[0]);
}

// O symlink parkado dentro de um slot, seja qual for o nome que o instalador
// escolha pra ele (<base>, <base>.original, ...). Asserções contra o NOME do
// artefato travariam o mecanismo; o que importa é que exista exatamente um
// link preservado e que o alvo dele seja byte-exato.
function soleParkedSymlink(slot) {
  const links = fs.readdirSync(slot)
    .filter((entry) => fs.lstatSync(path.join(slot, entry)).isSymbolicLink());
  assert.strictEqual(links.length, 1,
    `esperava exatamente 1 symlink preservado em ${slot}, achei: ${fs.readdirSync(slot).join(', ')}`);
  return path.join(slot, links[0]);
}

// Caminhos de arquivos regulares contendo `needle`. NÃO segue symlink: as skills
// promovidas são links pro próprio repo, e segui-los faria a busca vazar do
// HOME temp pro cortex real.
function filesContaining(root, needle) {
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (stat.isFile() && fs.readFileSync(current, 'utf8').includes(needle)) {
      hits.push(current);
    }
  }
  return hits;
}

// PATH com um shim na frente. Usado pra congelar `date` (forçar colisão de
// segundo) e pra falsear `shasum`/`sha256sum` (D1/D2).
function shimPath(home, name, script) {
  const bin = path.join(home, 'shim-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const executable of [].concat(name)) {
    fs.writeFileSync(path.join(bin, executable), script, { mode: 0o755 });
    fs.chmodSync(path.join(bin, executable), 0o755);
  }
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

// === 1. O bug original: skill do usuário num nome vendorado ==================

test('[installer] skill do usuário em nome vendorado sobrevive e fica recuperável', () => {
  const home = freshHome();
  try {
    const marker = 'MINHA SKILL REVIEW — conteúdo autoral do usuário';
    const userSkill = path.join(home, '.codex', 'skills', 'review');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), `${marker}\n`);

    const r = runCodex(home);
    assert.strictEqual(r.code, 0, `install falhou:\n${r.stderr}`);

    // Recuperável: o conteúdo continua existindo em algum lugar do HOME.
    const hits = filesContaining(home, marker);
    assert.strictEqual(hits.length, 1, `esperava 1 cópia do conteúdo do usuário, achei ${hits.length}`);

    // E está no slot de backup, não perdido nem deixado no skills/ (onde o
    // Codex o descobriria como skill e ele seria sobrescrito na próxima run).
    const slot = soleBackupSlot(codexBackups(home), 'review');
    assert.strictEqual(hits[0], path.join(slot, 'review', 'SKILL.md'));

    // O lugar foi ocupado pela skill vendorada, então o install de fato rodou.
    const installedSkill = path.join(home, '.codex', 'skills', 'review', 'SKILL.md');
    assert.ok(fs.existsSync(installedSkill), 'skill vendorada não foi instalada no lugar');
    assert.ok(!fs.readFileSync(installedSkill, 'utf8').includes(marker));

    assert.match(r.stdout, new RegExp(`Installed ${DERIVED.installed} local Codex skills`), r.stdout);
    assert.match(r.stdout, new RegExp(`Linked ${DERIVED.promoted} promoted cortex skills`), r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 2. Symlink estrangeiro preservado, alvo ainda legível ===================

test('[installer] codex preserva symlink estrangeiro com o alvo original legível', () => {
  const home = freshHome();
  try {
    const foreign = path.join(home, 'foreign-target.txt');
    const payload = 'alvo estrangeiro do usuário\n';
    fs.writeFileSync(foreign, payload);
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    fs.symlinkSync(foreign, path.join(home, '.codex', 'skills', 'qa'));

    assert.strictEqual(runCodex(home).code, 0);

    const parked = soleParkedSymlink(soleBackupSlot(codexBackups(home), 'qa'));
    assert.strictEqual(fs.readlinkSync(parked), foreign, 'o link parkado aponta pra outro lugar');
    assert.strictEqual(fs.readFileSync(parked, 'utf8'), payload, 'alvo original não é mais legível');
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), payload, 'o alvo em si foi tocado');
  } finally {
    rmHome(home);
  }
});

test('[installer] claude preserva symlink estrangeiro com o alvo original legível', () => {
  const home = freshHome();
  try {
    const foreign = path.join(home, 'foreign-target.txt');
    const payload = 'alvo estrangeiro do usuário (claude)\n';
    fs.writeFileSync(foreign, payload);
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(foreign, path.join(home, '.claude', 'skills', 'loop-hermes'));

    const r = runClaude(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou:\n${r.stderr}`);

    const parked = soleParkedSymlink(soleBackupSlot(claudeBackups(home), 'loop-hermes'));
    assert.strictEqual(fs.readlinkSync(parked), foreign);
    assert.strictEqual(fs.readFileSync(parked, 'utf8'), payload);
    // A preservação é anunciada: um backup silencioso é indistinguível de perda
    // pra quem está lendo o output.
    assert.match(r.stdout, /Backed up existing .*loop-hermes \(symlink -> /, r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 3. Symlink parkado round-trips byte-exato ==============================
// Duas armadilhas ao preservar um link:
//   RELATIVO — o alvo resolve contra o diretório pai, então relocar o link
//     silenciosamente re-aponta ele;
//   TRAILING NEWLINE — `readlink(1)` do BSD é lossy: a saída pra um link "/AA"
//     e pra um link "/AA\n" é byte-idêntica, então NENHUMA captura via shell
//     distingue os dois. Um link reconstruído a partir de readlink (ou um
//     sidecar com o "valor bruto") pode discordar do original em silêncio, e aí
//     o original é apagado.
// O contrato que importa é de RESULTADO, não de mecanismo: o alvo preservado é
// byte-exato e o link volta a resolver quando restaurado no lugar de origem.
// Por isso o teste não olha nome de artefato nem sidecar — só o round-trip.
// Os DOIS casos apontam pra arquivos REAIS e DISTINTOS, cujos nomes diferem só
// pelo newline final. É isso que dá dente ao caso do newline: um mecanismo
// lossy colapsa "thing.md\n" em "thing.md", o link restaurado passa a resolver
// pro arquivo ERRADO, e a asserção de payload pega. Sem os dois arquivos, um
// link com newline simplesmente não resolveria e o teste não distinguiria
// "preservado" de "quebrado".
const PARKED_LINK_CASES = [
  ['relativo', 'thing.md', 'conteudo sem newline no nome\n'],
  ['relativo com newline no fim', 'thing.md\n', 'conteudo COM newline no nome\n'],
];

function stageRelativeLink(homeDir, skills, linkName, fileName, payload) {
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'mine'), { recursive: true });
  // Ambos os arquivos existem sempre, então resolver pro certo é uma escolha,
  // não um acidente de qual dos dois existe.
  for (const [name, body] of PARKED_LINK_CASES.map(([, f, p]) => [f, p])) {
    fs.writeFileSync(path.join(homeDir, 'mine', name), body);
  }
  const rawTarget = `../mine/${fileName}`;
  fs.symlinkSync(rawTarget, path.join(skills, linkName));
  assert.strictEqual(fs.readFileSync(path.join(skills, linkName), 'utf8'), payload,
    'pré-condição: o link do usuário resolve pro arquivo certo antes do install');
  return rawTarget;
}

// Duas testemunhas independentes de que o alvo é byte-exato:
//   1. lstat().size de um symlink = tamanho em bytes do alvo. Equivale ao
//      `stat -f %z` do spec e não passa por readlink nenhum, então continua
//      válida mesmo se a leitura do link for lossy em alguma plataforma.
//   2. o valor lido. (Medido: fs.readlinkSync do Node É fiel, inclusive com
//      newline no fim — a perda do shell vem da substituição `$(...)`, que
//      remove newlines finais, não do readlink(1).)
function assertLinkTargetExact(parked, rawTarget, expectedSize, label) {
  assert.strictEqual(fs.lstatSync(parked).size, expectedSize,
    `[${label}] tamanho do alvo preservado difere do original (alvo reconstruído/truncado)`);
  assert.strictEqual(fs.readlinkSync(parked), rawTarget,
    `[${label}] alvo do link preservado não é byte-exato`);
}

function assertParkedLinkRoundTrips(slot, rawTarget, originalPath, payload, label, expectedSize) {
  const parked = soleParkedSymlink(slot);
  assertLinkTargetExact(parked, rawTarget, expectedSize, label);
  // Restaurar = mover de volta pra origem. Um inode movido pra um slot resolve
  // contra o slot, não contra o pai original — por design. O contrato é que ele
  // volte a resolver quando restaurado, e no MESMO arquivo de antes.
  fs.renameSync(parked, originalPath);
  assert.strictEqual(fs.readFileSync(originalPath, 'utf8'), payload,
    `[${label}] link restaurado resolve pro arquivo errado (mecanismo lossy)`);
}

test('[installer] codex preserva symlink parkado byte-exato e restaurável', () => {
  for (const [label, fileName, payload] of PARKED_LINK_CASES) {
    const home = freshHome();
    try {
      const skills = path.join(home, '.codex', 'skills');
      const rawTarget = stageRelativeLink(path.join(home, '.codex'), skills, 'qa', fileName, payload);
      const originalSize = fs.lstatSync(path.join(skills, 'qa')).size;

      assert.strictEqual(runCodex(home).code, 0, `[${label}] install falhou`);

      // O nome foi ocupado pela skill vendorada — o link não ficou pra trás.
      const installed = path.join(skills, 'qa');
      assert.ok(!fs.lstatSync(installed).isSymbolicLink(),
        `[${label}] o link do usuário continua ocupando skills/qa`);
      assert.ok(fs.existsSync(path.join(installed, 'SKILL.md')),
        `[${label}] a skill vendorada não foi instalada sobre o link`);
      fs.rmSync(installed, { recursive: true, force: true });
      assertParkedLinkRoundTrips(soleBackupSlot(codexBackups(home), 'qa'), rawTarget,
        installed, payload, label, originalSize);
    } finally {
      rmHome(home);
    }
  }
});

test('[installer] claude preserva symlink parkado byte-exato e restaurável', () => {
  for (const [label, fileName, payload] of PARKED_LINK_CASES) {
    const home = freshHome();
    try {
      const skills = path.join(home, '.claude', 'skills');
      const rawTarget = stageRelativeLink(
        path.join(home, '.claude'), skills, 'loop-hermes', fileName, payload);
      const originalSize = fs.lstatSync(path.join(skills, 'loop-hermes')).size;

      assert.strictEqual(runClaude(home).code, 0, `[${label}] bootstrap falhou`);

      fs.rmSync(path.join(skills, 'loop-hermes'), { recursive: true, force: true });
      assertParkedLinkRoundTrips(soleBackupSlot(claudeBackups(home), 'loop-hermes'), rawTarget,
        path.join(skills, 'loop-hermes'), payload, label, originalSize);
    } finally {
      rmHome(home);
    }
  }
});

// Links FORJADOS que capturam como "$source" numa comparação de shell mas não
// RESOLVEM. Duas variantes com a mesma raiz: "<source>/" e "<source>\n" — a
// segunda porque `$(readlink ...)` come o newline final. Se um caminho rápido
// confiar na comparação lexical sem exigir resolução, ele dá `rm -f` num link
// do usuário sem backup nenhum. Exigido: parkado byte-exato, e o NOSSO link
// instalado no lugar.
const FORGED_LINK_CASES = [
  ['barra no fim', (source) => `${source}/`, 'settings.json'],
  ['newline no fim', (source) => `${source}\n`, 'settings.json'],
];

test('[installer] claude parka link forjado não-resolvível em vez de removê-lo', () => {
  for (const [label, forge, name] of FORGED_LINK_CASES) {
    const home = freshHome();
    try {
      const source = path.join(REPO_ROOT, name);
      const forged = forge(source);
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const target = path.join(home, '.claude', name);
      fs.symlinkSync(forged, target);
      assert.ok(!fs.existsSync(target), `[${label}] pré-condição: o link forjado não resolve`);
      const originalSize = fs.lstatSync(target).size;

      assert.strictEqual(runClaude(home).code, 0, `[${label}] bootstrap falhou`);

      const parked = soleParkedSymlink(soleBackupSlot(claudeBackups(home), name));
      assertLinkTargetExact(parked, forged, originalSize, label);
      // E o destino terminou como o NOSSO link, com a grafia canônica.
      assert.strictEqual(fs.readlinkSync(target), source,
        `[${label}] nosso link não foi instalado no lugar`);
    } finally {
      rmHome(home);
    }
  }
});

// Mesma armadilha do lado codex, num nome PROMOVIDO: um link forjado como
// "<source>\n" não pode ser confundido com o nosso próprio link.
test('[installer] codex parka link forjado com newline num nome promovido', () => {
  const home = freshHome();
  try {
    const source = path.join(REPO_ROOT, 'active', 'skills', 'loop-hermes');
    const forged = `${source}\n`;
    const skills = path.join(home, '.codex', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(forged, path.join(skills, 'loop-hermes'));
    const originalSize = fs.lstatSync(path.join(skills, 'loop-hermes')).size;

    const r = runCodex(home);
    assert.strictEqual(r.code, 0, r.stderr);

    const parked = soleParkedSymlink(soleBackupSlot(codexBackups(home), 'loop-hermes'));
    assertLinkTargetExact(parked, forged, originalSize, 'newline no fim');
    assert.strictEqual(fs.readlinkSync(path.join(skills, 'loop-hermes')), source,
      'nosso link promovido não foi instalado no lugar');
    assert.match(r.stdout, new RegExp(`Linked ${DERIVED.promoted} promoted cortex skills`),
      'o link real precisa entrar na contagem depois de parkar o forjado');
  } finally {
    rmHome(home);
  }
});

// O agents_target tem o mesmo buraco de comparação lexical, e a exigência é a
// mesma do caso promovido acima: o link forjado NÃO é adotado como nosso, é
// PARKADO byte-exato, e o nosso link entra no lugar. Este teste já afirmou o
// contrário — que o forjado ficava onde estava e o impeccable não era linkado —
// e um verde ali pinava uma violação do park-always de AGENTS.md: o run saía 0
// com o link gerenciado ausente, e o doctor.sh depois reclamava de
// "Agents global Impeccable skill missing" numa instalação que disse ter dado
// certo.
test('[installer] codex parka link forjado no agents_target e linka o nosso', () => {
  const home = freshHome();
  try {
    const source = path.join(REPO_ROOT, 'active', 'skills', 'impeccable');
    const target = path.join(home, '.agents', 'skills', 'impeccable');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const forged = `${source}\n`;
    fs.symlinkSync(forged, target);
    const originalSize = fs.lstatSync(target).size;

    const r = runCodex(home);
    assert.strictEqual(r.code, 0, `run falhou:\n${r.stderr}`);

    // O objeto do usuário sobreviveu, byte-exato, num slot reservado.
    const parked = soleParkedSymlink(soleBackupSlot(codexBackups(home), 'impeccable'));
    assertLinkTargetExact(parked, forged, originalSize, 'agents_target forjado');
    assert.match(r.stderr, /impeccable is not the vendored skill; backed up to /, r.stderr);
    // E o alvo gerenciado ficou com a grafia canônica, sem o newline.
    assert.strictEqual(fs.readlinkSync(target), source,
      'o link do agents_target não foi instalado no lugar');
  } finally {
    rmHome(home);
  }
});

// O loop HM do bootstrap-claude.sh continua em SKIP+WARN. Esse arquivo é outra
// superfície de contrato e não foi tocado nesta mudança; a linha está aqui pra
// que a divergência seja visível em vez de implícita.
test('[installer] link forjado no HM do claude não é adotado nem tocado (skip+warn)', () => {
  const home = freshHome();
  try {
    const source = path.join(REPO_ROOT, 'codex', 'skills-local', 'hm-cli');
    const target = path.join(home, '.claude', 'skills', 'hm-cli');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const forged = `${source}\n`;
    fs.symlinkSync(forged, target);
    const before = fs.lstatSync(target).size;

    const r = runClaude(home);
    assert.strictEqual(r.code, 0, `run falhou:\n${r.stderr}`);

    assert.match(r.stderr, new RegExp(`${path.basename(target)}.*skipping`),
      `o link forjado precisa gerar warn de skip:\n${r.stderr}`);
    assert.strictEqual(fs.lstatSync(target).size, before, 'o link forjado foi tocado');
    assert.strictEqual(fs.readlinkSync(target), forged, 'o link forjado foi substituído');
  } finally {
    rmHome(home);
  }
});

// H5 — a mesma regra que vale pro skills/ vale pro staging: a run só remove o
// que ela mesma criou. Um .cortex-staging/ que já existia (e o que houver
// dentro dele) sobrevive; só o nosso run.* some.
test('[installer] staging pré-existente e seu conteúdo sobrevivem à run', () => {
  const home = freshHome();
  try {
    const parent = stagingParent(home);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, '.keep'), 'nao é nosso\n');

    assert.strictEqual(runCodex(home).code, 0);

    assert.ok(fs.existsSync(parent), 'o parent de staging pré-existente foi removido');
    assert.strictEqual(fs.readFileSync(path.join(parent, '.keep'), 'utf8'), 'nao é nosso\n',
      'arquivo alheio dentro do staging foi removido');
    assert.deepStrictEqual(stagingRuns(home), [], 'o nosso run dir não foi limpo');
  } finally {
    rmHome(home);
  }
});

// D3 — terceira direção do digest: o produtor emite bytes e SÓ ENTÃO falha. Um
// digest parcial não pode contar como igual; se contasse, a árvore do usuário
// seria "reconhecida" como nossa e pulada. Exigido: status honrado, tudo parka.
test('[installer] digest parcial (falha após emitir bytes) não conta como match (D3)', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runCodex(home).code, 0, 'install limpo falhou');

    const partialStat = '#!/bin/sh\necho "partial|Regular File|644|"\nexit 1\n';
    const r = runCodex(home, { path: shimPath(home, 'stat', partialStat) });
    assert.strictEqual(r.code, 0, `re-run falhou:\n${r.stderr}`);

    assert.deepStrictEqual(
      fs.readdirSync(codexBackups(home)).map((slot) => slot.replace(/\.backup\..*$/, '')).sort(),
      DERIVED.names, 'um digest parcial foi tratado como match e a árvore foi pulada');
    assert.match(r.stdout, new RegExp(`Installed ${DERIVED.installed} local Codex skills`));
  } finally {
    rmHome(home);
  }
});

// === 4. A prova de carga: digest errado nas DUAS direções não custa dado =====
// O digest não é fronteira de segurança. Estes dois testes forçam os dois erros
// possíveis e mostram que nenhum deles perde nada. São auto-mutantes: o shim de
// hash JÁ é a mutação, não existe versão "correta" do script que os faça passar
// por acidente.

test('[installer] digest falso-IGUAL não apaga conteúdo do usuário (D1)', () => {
  const home = freshHome();
  try {
    const marker = 'USER CONTENT';
    const userSkill = path.join(home, '.codex', 'skills', 'review');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), `${marker}\n`);

    // Todo digest é a mesma constante: qualquer árvore parece idêntica à staged,
    // então o instalador escolhe o branch "deixa quieto".
    const constantHash = '#!/bin/sh\ncat >/dev/null 2>&1\necho "constant  -"\n';
    const r = runCodex(home, { path: shimPath(home, ['shasum', 'sha256sum'], constantHash) });
    assert.strictEqual(r.code, 0, `install falhou:\n${r.stderr}`);

    // O pior que acontece é um refresh pulado. O conteúdo do usuário segue lá.
    assert.strictEqual(fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8'), `${marker}\n`);
    assert.deepStrictEqual(backupSlots(codexBackups(home), 'review'), [],
      'branch "idêntico" não deveria parkar nada');
  } finally {
    rmHome(home);
  }
});

test('[installer] digest falso-DIFERENTE parka tudo mas não perde nada (D2)', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runCodex(home).code, 0, 'install limpo falhou');

    // Digest sempre falha: nenhuma árvore parece igual, então TODAS são
    // parkadas em vez de deixadas quietas. Ruidoso, nunca destrutivo.
    const failingHash = '#!/bin/sh\nexit 1\n';
    const r = runCodex(home, { path: shimPath(home, ['shasum', 'sha256sum'], failingHash) });
    assert.strictEqual(r.code, 0, `re-run falhou:\n${r.stderr}`);

    const slots = fs.readdirSync(codexBackups(home));
    // Por NOME, não por contagem: prova que foi exatamente o conjunto instalado
    // que voltou parkado, e não envelhece quando o catálogo cresce.
    assert.deepStrictEqual(slots.map((slot) => slot.replace(/\.backup\..*$/, '')).sort(),
      DERIVED.names, 'conjunto parkado difere do conjunto instalado');
    assert.match(r.stdout, new RegExp(`Installed ${DERIVED.installed} local Codex skills`));
    // Cada slot guarda a árvore real, não um diretório vazio. (Nem toda skill
    // vendorada tem SKILL.md na raiz — anthropics-spec não tem — então a
    // asserção é "árvore não-vazia", que é o que "nada se perdeu" significa.)
    for (const slot of slots) {
      const base = slot.replace(/\.backup\..*$/, '');
      const parked = path.join(codexBackups(home), slot, base);
      assert.ok(fs.lstatSync(parked, { throwIfNoEntry: false })?.isDirectory(),
        `slot ${slot} não contém a árvore parkada`);
      assert.ok(fs.readdirSync(parked).length > 0, `árvore parkada em ${slot} está vazia`);
    }
  } finally {
    rmHome(home);
  }
});

// === 5. Exclusividade do slot: dois backups no mesmo segundo ================
// `date +%Y%m%d%H%M%S` colide trivialmente. `mktemp -d` reserva o destino ANTES
// de mover, então o segundo backup não pode sobrescrever nem aninhar dentro do
// primeiro. O shim de `date` congela o relógio pra forçar a colisão.

const FROZEN_DATE = '#!/bin/sh\necho 20260101000000\n';

test('[installer] codex: dois backups do mesmo alvo no mesmo segundo sobrevivem', () => {
  const home = freshHome();
  try {
    const frozen = shimPath(home, 'date', FROZEN_DATE);
    for (const round of [1, 2]) {
      const userSkill = path.join(home, '.codex', 'skills', 'review');
      fs.mkdirSync(userSkill, { recursive: true });
      fs.writeFileSync(path.join(userSkill, 'SKILL.md'), `user copy ${round}\n`);
      assert.strictEqual(runCodex(home, { path: frozen }).code, 0, `run ${round} falhou`);
    }
    assert.strictEqual(backupSlots(codexBackups(home), 'review').length, 2,
      'os dois backups do mesmo segundo deveriam coexistir');
    for (const round of [1, 2]) {
      assert.strictEqual(filesContaining(codexBackups(home), `user copy ${round}`).length, 1,
        `cópia ${round} do usuário sumiu na colisão de segundo`);
    }
  } finally {
    rmHome(home);
  }
});

test('[installer] claude: dois backups do mesmo alvo no mesmo segundo sobrevivem', () => {
  const home = freshHome();
  try {
    const frozen = shimPath(home, 'date', FROZEN_DATE);
    for (const round of [1, 2]) {
      const userSkill = path.join(home, '.claude', 'skills', 'loop-hermes');
      fs.rmSync(userSkill, { recursive: true, force: true });
      fs.mkdirSync(userSkill, { recursive: true });
      fs.writeFileSync(path.join(userSkill, 'SKILL.md'), `user skill ${round}\n`);
      assert.strictEqual(runClaude(home, { path: frozen }).code, 0, `run ${round} falhou`);
    }
    assert.strictEqual(backupSlots(claudeBackups(home), 'loop-hermes').length, 2);
    for (const round of [1, 2]) {
      assert.strictEqual(filesContaining(claudeBackups(home), `user skill ${round}`).length, 1,
        `cópia ${round} do usuário sumiu na colisão de segundo`);
    }
    // Um backup dentro de skills/ voltaria a ser descoberto como skill.
    assert.deepStrictEqual(
      filesContaining(path.join(home, '.claude', 'skills'), 'user skill '), [],
      'sobrou árvore de backup dentro de skills/',
    );
  } finally {
    rmHome(home);
  }
});

// === 6. Backup root symlinkado pra dentro de skills/ é recusado =============
// Se os backups caem dentro de skills/, a árvore preservada volta a ser
// descoberta como skill (e é sobrescrita na run seguinte). O guard resolve o
// path FISICAMENTE, então um symlink apontando pra lá não passa.

test('[installer] codex recusa backup root symlinkado pra dentro de skills/', () => {
  const home = freshHome();
  try {
    const skills = path.join(home, '.codex', 'skills');
    fs.mkdirSync(path.join(skills, 'inside'), { recursive: true });
    fs.mkdirSync(path.join(skills, 'review'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'review', 'SKILL.md'), 'u\n');
    fs.symlinkSync(path.join(skills, 'inside'), path.join(home, '.codex', 'sneaky'));

    const r = runCodex(home, { env: { GSTACK_BACKUP_DIR: path.join(home, '.codex', 'sneaky') } });
    assert.match(r.stderr, /Refusing to write backups inside the skills tree/, r.stderr);
    assert.notStrictEqual(r.code, 0, 'recusa deveria abortar com exit != 0');
    // Recusar não pode custar dado: a árvore do usuário fica intacta.
    assert.strictEqual(fs.readFileSync(path.join(skills, 'review', 'SKILL.md'), 'utf8'), 'u\n');
  } finally {
    rmHome(home);
  }
});

test('[installer] claude recusa backup root symlinkado pra dentro de skills/', () => {
  const home = freshHome();
  try {
    const skills = path.join(home, '.claude', 'skills');
    fs.mkdirSync(path.join(skills, 'inside'), { recursive: true });
    fs.mkdirSync(path.join(skills, 'loop-hermes'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'loop-hermes', 'SKILL.md'), 'u\n');
    fs.symlinkSync(path.join(skills, 'inside'), path.join(home, '.claude', 'sneaky'));

    const r = runClaude(home, { env: { CLAUDE_BACKUP_DIR: path.join(home, '.claude', 'sneaky') } });
    assert.match(r.stderr, /Refusing to write backups inside the skills tree/, r.stderr);
    assert.notStrictEqual(r.code, 0, 'recusa deveria abortar com exit != 0');
    assert.strictEqual(fs.readFileSync(path.join(skills, 'loop-hermes', 'SKILL.md'), 'utf8'), 'u\n');
  } finally {
    rmHome(home);
  }
});

// === 7. Idempotência: o estado permanente é silencioso ======================
// Comparar run 2 CONTRA run 1 em vez de contra números fixos: o que importa é
// que reinstalar não muda nada, e essa formulação não envelhece quando o
// catálogo de skills cresce.

test('[installer] codex re-run não cria backup e repete as mesmas contagens', () => {
  const home = freshHome();
  try {
    const first = runCodex(home);
    assert.strictEqual(first.code, 0, `1ª run falhou:\n${first.stderr}`);
    const second = runCodex(home);
    assert.strictEqual(second.code, 0, `2ª run falhou:\n${second.stderr}`);

    const counts = (out) => out.split('\n')
      .filter((line) => /^(Installed|Linked) /.test(line))
      .map((line) => line.replace(/ into .*$/, ''));
    assert.deepStrictEqual(counts(second.stdout), counts(first.stdout),
      're-run reportou contagens diferentes da 1ª run');
    assert.deepStrictEqual(counts(first.stdout), [
      `Installed ${DERIVED.installed} local Codex skills`,
      `Linked ${DERIVED.promoted} promoted cortex skills`,
    ]);

    assert.deepStrictEqual(fs.existsSync(codexBackups(home)) ? fs.readdirSync(codexBackups(home)) : [],
      [], 're-run parkou algo que ela mesma instalou');
    assert.strictEqual(second.stderr.split('\n').filter((l) => l.startsWith('warn:')).length, 0,
      `re-run deveria ser silenciosa:\n${second.stderr}`);
    // A propriedade de segurança é que NADA staged sobra: nenhum run dir, e o
    // parent (se persistir) vazio. Deliberadamente não se exige que o parent
    // vazio seja removido — isso é arrumação, não preservação, e as duas
    // variantes já circularam no script (o `rmdir` do trap foi e voltou).
    // Pinar a arrumação faria este teste vermelho por churn alheio.
    assert.deepStrictEqual(stagingRuns(home), [], 'run dir de staging vazou');
    const stagingLeft = fs.existsSync(stagingParent(home))
      ? fs.readdirSync(stagingParent(home)) : [];
    assert.deepStrictEqual(stagingLeft, [], `sobrou conteúdo staged: ${stagingLeft.join(', ')}`);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(home, '.codex', 'skills')).filter((e) => e.includes('.backup.')), []);
  } finally {
    rmHome(home);
  }
});

test('[installer] claude re-run não cria backup e mantém os mesmos symlinks de topo', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runClaude(home).code, 0, '1ª run falhou');
    const topLevelLinks = () => fs.readdirSync(path.join(home, '.claude'))
      .filter((e) => fs.lstatSync(path.join(home, '.claude', e)).isSymbolicLink()).sort();
    const before = topLevelLinks();
    // Nomes, não contagem: pinar 15 quebraria ao adicionar um arquivo linkado.
    assert.ok(before.length > 0, 'nenhum symlink de topo foi criado');

    assert.strictEqual(runClaude(home).code, 0, '2ª run falhou');
    assert.deepStrictEqual(topLevelLinks(), before, 're-run mudou os symlinks de topo');
    assert.deepStrictEqual(
      fs.readdirSync(path.join(home, '.claude')).filter((e) => e.includes('.backup.')), [],
      're-run deixou backup no topo do CLAUDE_HOME');
    assert.deepStrictEqual(
      fs.existsSync(claudeBackups(home)) ? fs.readdirSync(claudeBackups(home)) : [], [],
      're-run parkou algo que ela mesma linkou');
  } finally {
    rmHome(home);
  }
});

// === 8. Nenhum `cmp: ...: Is a directory` no stderr =========================
// O branch de diretório já caiu num `cmp -s` que só chegava ao backup por
// acidente (com "Is a directory" vazando no stderr). Hoje é explícito.

test('[installer] claude preserva dir do usuário sem vazar "Is a directory"', () => {
  const home = freshHome();
  try {
    fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'commands', 'mine.md'), 'x\n');

    const r = runClaude(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Is a directory/, r.stderr);
    assert.doesNotMatch(r.stderr, /^cmp:/m, r.stderr);
    // O ponto do branch: o dir do usuário é preservado, não removido.
    assert.strictEqual(filesContaining(claudeBackups(home), 'x').length, 1,
      'commands/ do usuário não foi preservado');
  } finally {
    rmHome(home);
  }
});

// === 9. Nome PROMOVIDO com dir real do usuário: park, e o link entra ========
// Não há assimetria. Este teste já exigiu o contrário — skip + warn, dir do
// usuário intocado, `Linked promoted-1` — sob o argumento de que "nada quebra
// deixando-o onde está". Quebra: a skill promovida do cortex simplesmente não
// existia no Codex, e o run saía 0. Isso é exatamente a violação do
// park-always de AGENTS.md ("nome que colide com um alvo gerenciado é
// PARQUEADO ... nunca deletado"), e um teste verde estava pinando ela.
// O contrato agora é único pros dois loops: o objeto do usuário é preservado
// com o inode intacto num slot reservado, e o link gerenciado ocupa o nome.

test('[installer] dir do usuário em nome promovido é parkado e o link entra', () => {
  const home = freshHome();
  try {
    const marker = 'minha orchestrate\n';
    const userSkill = path.join(home, '.codex', 'skills', 'orchestrate');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), marker);
    // Inode do dir, não do arquivo: é o dir que é movido, e "movido, não
    // recriado" é a propriedade que o park promete.
    const originalIno = fs.lstatSync(userSkill).ino;

    const r = runCodex(home);
    assert.strictEqual(r.code, 0, `install falhou:\n${r.stderr}`);

    // O dir do usuário foi PRESERVADO: mesmo inode, mesmo conteúdo, num slot.
    const slot = soleBackupSlot(codexBackups(home), 'orchestrate');
    const preserved = filesContaining(slot, marker);
    assert.strictEqual(preserved.length, 1,
      `esperava o SKILL.md do usuário preservado em ${slot}, achei: ${preserved.join(', ')}`);
    assert.strictEqual(fs.lstatSync(path.dirname(preserved[0])).ino, originalIno,
      'o dir do usuário foi recriado em vez de movido (inode diferente)');
    assert.match(r.stderr, /orchestrate is not the vendored skill; backed up to /, r.stderr);

    // E o nome ficou com o NOSSO link, então a contagem é a cheia.
    assert.strictEqual(fs.readlinkSync(userSkill),
      path.join(REPO_ROOT, 'active', 'skills', 'orchestrate'),
      'o link promovido não foi instalado depois do park');
    assert.match(r.stdout, new RegExp(`Linked ${DERIVED.promoted} promoted cortex skills`), r.stdout);
  } finally {
    rmHome(home);
  }
});

// === 10. Installs concorrentes não produzem skill aninhada ==================
// Não existe lock. Duas runs simultâneas contra o mesmo CODEX_HOME correm entre
// o `[ -e "$target" ]` e o rename: se a outra run criar o diretório-alvo nesse
// intervalo, o `mv` do BSD move a árvore staged PARA DENTRO dele
// (`$target/$name`) e sai 0 — skill corrompida, as duas runs reportando
// sucesso. A corrida sozinha só dispara ~40% das vezes, o que daria um teste
// verde contra código quebrado; o shim de `mv` abaixo atrasa só o rename do
// primeiro nome e torna a colisão determinística. O shim muda TEMPO, não
// comportamento: ele exec'a o `mv` real.

function spawnCodex(home, extraPath) {
  return spawn('bash', [CODEX_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...fixtureEnv(home),
      ...(extraPath ? { PATH: extraPath } : {}),
    },
  });
}

// Registrado NA HORA do spawn: um `close` só é observado por quem já estava
// escutando, então prender o listener depois de um await perde o evento de um
// filho que morreu cedo — e o teste fica pendurado pra sempre.
function closed(child, deadlineMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child não terminou em ${deadlineMs}ms`));
    }, deadlineMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const closedCode = async (child) => (await closed(child)).code;

// G3a — DETERMINÍSTICO. `place_tree` é extraída do script e rodada com um `mv`
// shimado que cria o destino ANTES de renomear: a corrida é perdida de
// propósito, não por sorte. Uma versão só end-to-end (G3b abaixo) passa quando
// a corrida simplesmente não acontece — medido: dispara ~40% das vezes — e
// portanto não provaria nada sozinha.
test('[installer] place_tree desfaz um aninhamento causado por corrida perdida', () => {
  const home = freshHome();
  try {
    const source = fs.readFileSync(CODEX_SCRIPT, 'utf8');
    const extracted = source.match(/^place_tree\(\) \{[\s\S]*?^\}$/m);
    assert.ok(extracted, 'place_tree não pôde ser extraída de install-codex-skills.sh');

    const stage = path.join(home, 'stage', 'review.999');
    const skills = path.join(home, 'skills');
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(stage, 'SKILL.md'), 'staged\n');

    // O shim roda UMA vez: cria o diretório-alvo (o que a outra run faria) e só
    // então chama o mv real, que passa a mover a árvore PARA DENTRO dele.
    const runner = path.join(home, 'run.sh');
    fs.writeFileSync(runner, `set -uo pipefail
${extracted[0]}
mv() {
  if [ ! -e "${home}/.raced" ]; then
    : > "${home}/.raced"
    mkdir -p "${skills}/review"
    echo winner > "${skills}/review/SKILL.md"
  fi
  command mv "$@"
}
place_tree "${stage}" "${skills}/review"; echo "rc=$?"
`);
    const r = spawnSync('bash', [runner], { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.stdout.trim().split('\n').pop(), 'rc=1',
      `place_tree devia reportar o nome tomado:\n${r.stdout}\n${r.stderr}`);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(skills, 'review')).filter((e) => e.startsWith('review.')), [],
      'o aninhamento não foi desfeito');
    assert.strictEqual(fs.readFileSync(path.join(stage, 'SKILL.md'), 'utf8'), 'staged\n',
      'a árvore staged não voltou intacta');
    assert.strictEqual(fs.readFileSync(path.join(skills, 'review', 'SKILL.md'), 'utf8'), 'winner\n',
      'a árvore que ganhou a corrida foi tocada');
  } finally {
    rmHome(home);
  }
});

// G3c — end-to-end e DETERMINÍSTICO. G3a prova que place_tree se comporta, mas
// não que os call sites a usem: tirar o guard de um chamador passa em G3a. G3b
// exercita o fluxo inteiro mas só dispara a corrida ~40% das vezes, ou seja, o
// mutante sobrevive à maioria das runs. Aqui a corrida é forçada DENTRO da run
// completa de install-codex-skills.sh, com o mesmo shim de `mv` de G3a: na
// primeira tentativa de renomear pra skills/review o destino já existe (o que
// a outra run teria feito), então o `mv` do BSD aninha a árvore staged lá
// dentro. O shim muda TEMPO, não comportamento — ele exec'a o mv real.
//
// O resultado exigido cobre as duas metades: o aninhamento é desfeito E a
// árvore que ganhou a corrida não é perdida (a 2ª tentativa a parka).
test('[installer] corrida perdida no rename end-to-end: sem aninhar e sem perder o vencedor', () => {
  const home = freshHome();
  try {
    const raced = path.join(home, '.raced');
    // Sem newline na constante do shell: `"...\n"` entre aspas duplas é um
    // backslash-n LITERAL pro printf '%s'. O newline entra pelo formato.
    const winnerBody = 'ARVORE QUE GANHOU A CORRIDA';
    const winner = `${winnerBody}\n`;
    const racingMv = shimPath(home, 'mv', `#!/bin/sh
case "$2" in
  */skills/review)
    if [ ! -e ${JSON.stringify(raced)} ]; then
      : > ${JSON.stringify(raced)}
      mkdir -p "$2"
      printf '%s\\n' ${JSON.stringify(winnerBody)} > "$2/SKILL.md"
    fi
    ;;
esac
exec /bin/mv "$@"
`);
    const r = runCodex(home, { path: racingMv });
    assert.strictEqual(r.code, 0, `install falhou:\n${r.stderr}`);
    // Sem isto o teste seria vacuoso do mesmo jeito que G3b: verde porque a
    // corrida nunca aconteceu.
    assert.ok(fs.existsSync(raced), 'a corrida nunca foi forçada: o shim não pegou o rename');

    const installed = path.join(home, '.codex', 'skills', 'review');
    assert.deepStrictEqual(fs.readdirSync(installed).filter((e) => e.startsWith('review.')), [],
      'a árvore staged ficou aninhada dentro de skills/review');
    assert.ok(fs.existsSync(path.join(installed, 'SKILL.md')),
      'a skill vendorada não foi instalada depois da corrida perdida');
    assert.notStrictEqual(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), winner,
      'skills/review ficou com a árvore da corrida, não com a nossa');

    // A vencedora não é nossa: a 2ª tentativa tem de PARKAR, nunca remover.
    const slot = soleBackupSlot(codexBackups(home), 'review');
    assert.strictEqual(fs.readFileSync(path.join(slot, 'review', 'SKILL.md'), 'utf8'), winner,
      'a árvore que ganhou a corrida foi perdida em vez de parkada');
    assert.strictEqual(filesContaining(home, winner).length, 1,
      'esperava exatamente 1 cópia da árvore vencedora');

    // A run se declara completa: a corrida custou uma tentativa, não uma skill.
    assert.match(r.stdout, new RegExp(`Installed ${DERIVED.installed} local Codex skills`), r.stdout);
    assert.deepStrictEqual(stagingRuns(home), [], 'run dir de staging vazou');
  } finally {
    rmHome(home);
  }
});

// G3b — end-to-end não determinístico. Sozinho seria vacuoso (a corrida pode não
// acontecer — medido: ~40%), e G3c acima é quem trava a regressão; este fica
// como sanidade de que três runs simultâneas de verdade terminam limpas.
test('[installer] três runs concorrentes terminam sem skill aninhada', async () => {
  const home = freshHome();
  try {
    const codes = await Promise.all([0, 1, 2].map(() => closedCode(spawnCodex(home))));
    assert.deepStrictEqual(codes, [0, 0, 0], 'alguma run concorrente falhou');

    const skills = path.join(home, '.codex', 'skills');
    const nested = fs.readdirSync(skills).filter((name) =>
      fs.readdirSync(path.join(skills, name), { withFileTypes: true })
        .some((entry) => entry.isDirectory() && entry.name.startsWith(`${name}.`)));
    assert.deepStrictEqual(nested, [],
      `árvore staged aninhada por rename concorrente: ${nested.join(', ')}`);

    const missing = DERIVED.names.filter((name) => !fs.existsSync(path.join(skills, name)));
    assert.deepStrictEqual(missing, [], `skills ausentes após runs concorrentes: ${missing.join(', ')}`);
  } finally {
    rmHome(home);
  }
});

// === 11. SIGKILL no meio do install: degradado, nunca destrutivo ============
// `trap ... EXIT` não roda no SIGKILL e a varredura de recuperação foi removida
// de propósito (um glob `rm -rf` sobre paths que a run não criou era o perigo
// que este redesign eliminou). O teste trava o que REALMENTE acontece.

// A janela perigosa é ESTREITA: entre `mv target -> slot` (park) e o
// `place_tree` que recoloca a árvore. Nesse instante o nome não existe mais em
// skills/ e a única cópia do trabalho do usuário está no slot. Matar por
// wall-clock ("espera 700ms") NÃO prova nada: o kill cai onde cair, e as
// asserções passam porque o install limpo anterior já deixou tudo no lugar.
// Aqui um shim de `mv` sinaliza uma BARREIRA no exato instante em que o park
// termina e então trava; o teste espera a barreira e só aí manda SIGKILL.
test('[installer] SIGKILL exatamente na janela park→place não perde a árvore', async () => {
  const home = freshHome();
  let child;
  try {
    assert.strictEqual(runCodex(home).code, 0, 'install limpo falhou');

    // Trabalho do usuário sob um nome vendorado: a re-run TEM de parkar isto.
    const marker = 'ARVORE DO USUARIO — nao pode sumir na janela\n';
    const userSkill = path.join(home, '.codex', 'skills', 'review');
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), marker);

    // A barreira dispara ANTES da recolocação em skills/review, ou seja: o que
    // quer que o script tenha feito com a árvore existente já aconteceu, e o
    // lugar ainda está vazio. Deliberadamente NÃO se prende ao mecanismo de
    // park (não casa com "*.backup.*/review"): se alguém trocar o park por um
    // `rm -rf`, a barreira continua disparando e o teste falha por PERDA — que
    // é o que ele existe pra pegar — em vez de falhar por "barreira nunca
    // atingida", que seria vermelho pelo motivo errado.
    // Só esta re-run tem o shim; o install limpo acima rodou sem ele, então o
    // único mv pra */skills/review é o desta janela.
    const barrier = path.join(home, '.parked-barrier');
    const barrierPath = shimPath(home, 'mv', `#!/bin/sh
case "$2" in
  */skills/review) : > ${JSON.stringify(barrier)}; sleep 30 ;;
esac
exec /bin/mv "$@"
`);
    // detached: o SIGKILL vai pro GRUPO, senão o shim e o sleep sobrevivem.
    child = spawn('bash', [CODEX_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, ...fixtureEnv(home), PATH: barrierPath },
    });
    const finished = closed(child, 90000); // registrado JÁ, antes de qualquer await

    const deadline = Date.now() + 60000;
    while (!fs.existsSync(barrier)) {
      if (Date.now() > deadline) throw new Error('a barreira nunca foi atingida: o park não aconteceu');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.kill(-child.pid, 'SIGKILL');
    const { signal } = await finished;
    assert.strictEqual(signal, 'SIGKILL', 'o processo precisa ter morrido de SIGKILL dentro da janela');

    // Estamos DENTRO da janela: skills/review foi liberado e ainda não foi
    // recolocado. A única cópia do trabalho do usuário está no slot — e tem de
    // estar lá, byte-exata.
    const hits = filesContaining(home, marker);
    assert.strictEqual(hits.length, 1,
      `esperava exatamente 1 cópia da árvore do usuário na janela, achei ${hits.length}`);
    assert.ok(hits[0].startsWith(codexBackups(home) + path.sep),
      `a cópia sobrevivente está fora do backup root: ${hits[0]}`);
    assert.strictEqual(fs.readFileSync(hits[0], 'utf8'), marker);

    // Invariante geral: nenhum nome sumiu — instalado OU parkado.
    const skills = path.join(home, '.codex', 'skills');
    const parked = new Set(fs.readdirSync(codexBackups(home))
      .map((slot) => slot.replace(/\.backup\..*$/, '')));
    const lost = DERIVED.names.filter((name) =>
      !fs.lstatSync(path.join(skills, name), { throwIfNoEntry: false }) && !parked.has(name));
    assert.deepStrictEqual(lost, [], `skills perdidas pelo SIGKILL: ${lost.join(', ')}`);

    // G4: sem trap no SIGKILL, o run dir de staging fica. Contrato = reportado,
    // nunca varrido por um glob rm -rf sobre paths de outras runs.
    const leftovers = stagingRuns(home);
    assert.ok(leftovers.length >= 1, 'esperava o run dir de staging órfão do SIGKILL');

    const recovery = runCodex(home);
    assert.strictEqual(recovery.code, 0, `run de recuperação falhou:\n${recovery.stderr}`);
    assert.match(recovery.stdout, new RegExp(`Installed ${DERIVED.installed} local Codex skills`));
    assert.match(recovery.stderr, /staging dir\(s\).*left by interrupted or concurrent runs/,
      'o staging órfão precisa ser reportado, não varrido em silêncio');
    assert.ok(stagingRuns(home).length >= leftovers.length,
      'a run de recuperação varreu um run dir que não era dela');
  } finally {
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* já morreu */ }
    rmHome(home);
  }
});

// === 12. Links aposentados são PARKADOS, não removidos =====================
// config.json e mcp-servers deixaram de ser gerenciados. As duas branches já
// foram `rm -f` puro: restaurá-lo destrói o link do usuário sem deixar rastro,
// e nenhum outro teste desta suíte olha para esses nomes.

test('[installer] claude parka links aposentados (config.json, mcp-servers)', () => {
  for (const [name, retiredTarget] of [
    ['config.json', path.join(REPO_ROOT, 'config.json')],
    ['mcp-servers', path.join(REPO_ROOT, 'mcp-servers')],
  ]) {
    const home = freshHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const target = path.join(home, '.claude', name);
      fs.symlinkSync(retiredTarget, target);
      const originalSize = fs.lstatSync(target).size;

      const r = runClaude(home);
      assert.strictEqual(r.code, 0, `[${name}] bootstrap falhou:\n${r.stderr}`);

      // Aposentado: sai do CLAUDE_HOME...
      assert.strictEqual(fs.lstatSync(target, { throwIfNoEntry: false }), undefined,
        `[${name}] o link aposentado continua no CLAUDE_HOME`);
      // ...mas PARKADO, nunca unlinkado.
      const parked = soleParkedSymlink(soleBackupSlot(claudeBackups(home), name));
      assertLinkTargetExact(parked, retiredTarget, originalSize, name);
    } finally {
      rmHome(home);
    }
  }
});

// === 13. bootstrap-codex.sh ================================================
// Nenhum outro teste executa este script: CODEX_SCRIPT aponta pro
// install-codex-skills.sh. Ele tem a MESMA primitiva link_file/backup_target,
// mais a única exceção aprovada pelo dono (alias físico do mesmo source é
// unlinkado em vez de parkado) — e é o arquivo mais churnado dos três.

test('[installer] bootstrap-codex parka arquivo e symlink estrangeiros no lugar de um alvo', () => {
  const home = freshHome();
  try {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    // Arquivo real do usuário onde vai um link gerenciado.
    const fileBody = 'AGENTS.md que o usuário escreveu\n';
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), fileBody);
    // Symlink estrangeiro onde vai outro link gerenciado.
    const foreign = path.join(home, 'foreign-rtk.md');
    fs.writeFileSync(foreign, 'alvo estrangeiro\n');
    fs.symlinkSync(foreign, path.join(codexHome, 'RTK-codex.md'));
    const foreignSize = fs.lstatSync(path.join(codexHome, 'RTK-codex.md')).size;

    const r = runCodexBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap-codex falhou:\n${r.stderr}\n${r.stdout}`);

    // Arquivo do usuário preservado no slot, conteúdo intacto.
    const fileSlot = soleBackupSlot(path.join(codexHome, 'backups'), 'AGENTS.md');
    assert.strictEqual(fs.readFileSync(path.join(fileSlot, 'AGENTS.md'), 'utf8'), fileBody);
    // Symlink estrangeiro preservado byte-exato e ainda legível.
    const linkSlot = soleBackupSlot(path.join(codexHome, 'backups'), 'RTK-codex.md');
    const parkedLink = soleParkedSymlink(linkSlot);
    assertLinkTargetExact(parkedLink, foreign, foreignSize, 'RTK-codex.md');
    assert.strictEqual(fs.readFileSync(parkedLink, 'utf8'), 'alvo estrangeiro\n');

    // E os dois destinos terminaram como NOSSOS links canônicos.
    assert.strictEqual(fs.readlinkSync(path.join(codexHome, 'AGENTS.md')),
      path.join(REPO_ROOT, 'AGENTS.md'));
    assert.strictEqual(fs.readlinkSync(path.join(codexHome, 'RTK-codex.md')),
      path.join(REPO_ROOT, 'RTK-codex.md'));
  } finally {
    rmHome(home);
  }
});

test('[installer] bootstrap-codex parka link forjado e diretório de skill do usuário', () => {
  const home = freshHome();
  try {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(path.join(codexHome, 'skills'), { recursive: true });
    // Forjado: captura como "$source" num shell, mas não resolve.
    const hooksSource = path.join(REPO_ROOT, 'codex', 'hooks.json');
    const forged = `${hooksSource}\n`;
    fs.symlinkSync(forged, path.join(codexHome, 'hooks.json'));
    const forgedSize = fs.lstatSync(path.join(codexHome, 'hooks.json')).size;
    // Diretório REAL do usuário no lugar de uma agent-skill: é parkado.
    // (O caso do incidente — um SYMLINK para diretório — é outro, e está no
    // teste de alias físico abaixo. Confundir os dois foi o que deixou a
    // classe de dano sem cobertura.)
    const skillDir = path.join(codexHome, 'skills', 'caveman');
    fs.mkdirSync(skillDir, { recursive: true });
    const dirMarker = 'minha caveman\n';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), dirMarker);

    const r = runCodexBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap-codex falhou:\n${r.stderr}\n${r.stdout}`);

    const backups = path.join(codexHome, 'backups');
    assertLinkTargetExact(soleParkedSymlink(soleBackupSlot(backups, 'hooks.json')),
      forged, forgedSize, 'hooks.json forjado');
    assert.strictEqual(fs.readlinkSync(path.join(codexHome, 'hooks.json')), hooksSource,
      'o link forjado foi adotado em vez de parkado');

    const dirSlot = soleBackupSlot(backups, 'caveman');
    assert.strictEqual(fs.readFileSync(path.join(dirSlot, 'caveman', 'SKILL.md'), 'utf8'), dirMarker,
      'o diretório de skill do usuário não foi preservado');
    assert.ok(fs.lstatSync(skillDir).isSymbolicLink(), 'a agent-skill não foi linkada no lugar');
  } finally {
    rmHome(home);
  }
});

// Digest de uma árvore: path relativo -> tipo + MODO + conteúdo/alvo. Serve pra
// provar que a ÁRVORE FONTE não foi tocada. Exit code e contagem de backup podem
// estar todos certos enquanto o dano acontece em outro lugar — foi assim que o
// incidente original passou despercebido.
//
// O modo entra em TODO registro, e não é zelo abstrato: o dano em
// cursor/hooks/rtk-shell.js foi truncação (2191 -> 10 bytes) MAIS `chmod 755 ->
// 600`, e o chmod sozinho já quebrava o hook. Tamanho e conteúdo pegam a
// truncação; sem o modo, um chmod de conteúdo idêntico passa despercebido — que
// é exatamente metade daquele incidente.
function treeDigest(root) {
  const digest = new Map();
  const walk = (current, relative) => {
    const stat = fs.lstatSync(current);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      digest.set(relative, `link:${mode}:${fs.readlinkSync(current)}`);
      return;
    }
    if (stat.isDirectory()) {
      digest.set(relative, `dir:${mode}`);
      for (const entry of fs.readdirSync(current).sort()) {
        walk(path.join(current, entry), relative ? path.join(relative, entry) : entry);
      }
      return;
    }
    digest.set(relative, `file:${mode}:${stat.size}:${fs.readFileSync(current).toString('base64')}`);
  };
  walk(root, '');
  return digest;
}

// Compara e falha. Só isso: NÃO existe caminho de remoção aqui.
//
// A versão anterior apagava toda entrada ausente do snapshot inicial, tentando
// conter o estrago de uma run quebrada contra o checkout real. Era um `rm -rf`
// por diferença de snapshot, apontado pra árvore viva, sem provar que o teste
// tinha criado o que estava apagando — a mesma classe de defeito que esta suíte
// inteira existe pra travar — e ainda por cima não restaurava nada que tivesse
// sido MODIFICADO ou truncado, só o que tivesse sido criado.
//
// A necessidade morreu com copyCheckout(): quem exercita esses caminhos roda
// contra uma cópia descartável, então não há nada a conter. Se este comparador
// voltar a apontar pra uma árvore que precisa sobreviver ao teste, o erro está
// no chamador, não aqui.
function assertTreeUnchanged(root, before, label) {
  const { added, removed, changed } = diffSets(before, treeDigest(root));
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return;
  assert.fail(`[${label}] a ÁRVORE FONTE foi modificada — `
    + `criados: [${added.join(', ')}] removidos: [${removed.join(', ')}] `
    + `alterados: [${changed.join(', ')}]`);
}

// O detector é carga: se ele for cego pra uma classe de dano, todo teste que
// depende dele fica verde contra código destrutivo. O caso que discrimina é
// chmod de CONTEÚDO IDÊNTICO — truncação já é pega por tamanho/bytes, então uma
// mutação "trunca e faz chmod" passaria mesmo sem o modo no registro. Aqui o
// conteúdo não é tocado em nenhum dos dois casos de chmod: só o modo muda.
test('[installer] o detector de árvore pega chmod de conteúdo idêntico (arquivo e dir)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-digest-'));
  try {
    const file = path.join(root, 'hook.js');
    const body = '#!/usr/bin/env node\nprocess.exit(0);\n';
    fs.writeFileSync(file, body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    const dir = path.join(root, 'sub');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.symlinkSync(path.join(root, 'hook.js'), path.join(root, 'link'));
    const before = treeDigest(root);

    // Controle: sem mutação nenhuma, o comparador precisa ficar quieto. Sem
    // isso, um comparador que falha SEMPRE passaria nos casos abaixo.
    assertTreeUnchanged(root, before, 'controle');

    // 1. chmod só no arquivo — os bytes continuam idênticos (a metade do
    //    incidente do rtk-shell.js que tamanho e conteúdo não veem).
    fs.chmodSync(file, 0o600);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), body, 'o caso precisa ser chmod PURO');
    assert.throws(() => assertTreeUnchanged(root, before, 'chmod arquivo'),
      /chmod arquivo.*alterados: \[hook\.js\]/s,
      'chmod de conteúdo idêntico em arquivo passou despercebido');
    fs.chmodSync(file, 0o755);
    assertTreeUnchanged(root, before, 'arquivo restaurado');

    // 2. chmod só no diretório — mesma cegueira, outro tipo de entrada.
    fs.chmodSync(dir, 0o700);
    assert.throws(() => assertTreeUnchanged(root, before, 'chmod dir'),
      /chmod dir.*alterados: \[sub\]/s,
      'chmod em diretório passou despercebido');
    fs.chmodSync(dir, 0o755);

    // 3. As outras classes que o incidente misturou, pra o registro: truncação,
    //    entrada nova (o espalhamento) e re-alvo de symlink.
    fs.writeFileSync(file, '#!/usr/bin/env');
    assert.throws(() => assertTreeUnchanged(root, before, 'truncação'), /alterados: \[hook\.js\]/);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);

    fs.writeFileSync(path.join(root, 'stray.md'), 'espalhado\n');
    assert.throws(() => assertTreeUnchanged(root, before, 'arquivo espalhado'),
      /criados: \[stray\.md\]/);
    fs.rmSync(path.join(root, 'stray.md'));

    fs.rmSync(path.join(root, 'link'));
    fs.symlinkSync(path.join(root, 'outro'), path.join(root, 'link'));
    assert.throws(() => assertTreeUnchanged(root, before, 'symlink re-apontado'),
      /alterados: \[link\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A ÚNICA exclusão aprovada pelo dono: um symlink que RESOLVE e é alias físico
// do mesmo source é unlinkado e re-apontado, sem backup.
//
// Parametrizado em DUAS dimensões porque cada uma escondia um buraco:
//   RUNNER — a branch é copiada em bootstrap-codex.sh e bootstrap-claude.sh;
//     cobrir só um deixava remover a do outro passar batido.
//   ALVO DO ALIAS — arquivo vs DIRETÓRIO. Só o caso do diretório reproduz o
//     incidente: `mv -f <link staged> <symlink-para-dir>` SEGUE o link no BSD,
//     sai 0, deixa o alias sem re-apontar e escreve dentro da árvore fonte.
//     Um fixture com diretório real não exercita nada disso.
const PHYSICAL_ALIAS_CASES = [
  {
    label: 'codex, alias -> arquivo',
    run: runCodexBootstrap,
    scriptName: 'bootstrap-codex.sh',
    managedHome: (home) => path.join(home, '.codex'),
    sourceRelative: ['AGENTS.md'],
    targetRelative: ['AGENTS.md'],
  },
  {
    label: 'codex, alias -> DIRETÓRIO (o caso do incidente)',
    run: runCodexBootstrap,
    scriptName: 'bootstrap-codex.sh',
    managedHome: (home) => path.join(home, '.codex'),
    sourceRelative: ['codex', 'agent-skills', 'caveman'],
    targetRelative: ['skills', 'caveman'],
  },
  {
    label: 'claude, alias -> arquivo',
    run: runClaude,
    scriptName: 'bootstrap-claude.sh',
    managedHome: (home) => path.join(home, '.claude'),
    sourceRelative: ['settings.json'],
    targetRelative: ['settings.json'],
  },
  {
    label: 'claude, alias -> DIRETÓRIO (o caso do incidente)',
    run: runClaude,
    scriptName: 'bootstrap-claude.sh',
    managedHome: (home) => path.join(home, '.claude'),
    sourceRelative: ['active', 'skills', 'loop-hermes'],
    targetRelative: ['skills', 'loop-hermes'],
  },
];

// Este é o único teste da suíte cujo caminho sob teste consegue ESCREVER na
// árvore fonte (`mv -f <link staged> <symlink-para-dir>` segue o link no BSD e
// escreve lá dentro). Por isso ele roda contra uma CÓPIA do checkout: uma versão
// quebrada espalha o que quiser, a cópia é descartada no finally e o checkout
// real nunca é destino de escrita — em vez de ser limpo depois do estrago.
test('[installer] alias físico do mesmo source é re-apontado sem parkar e sem tocar a fonte', () => {
  for (const testCase of PHYSICAL_ALIAS_CASES) {
    const home = freshHome();
    const cortex = copyCheckout();
    try {
      const source = path.join(cortex, ...testCase.sourceRelative);
      // Duas testemunhas: byte-a-byte na subárvore fonte, e o conjunto de
      // entradas do checkout INTEIRO — porque "espalhou arquivo no repo" não
      // acontece necessariamente dentro da subárvore que o caso usa.
      const sourceBefore = treeDigest(source);
      const cortexBefore = entrySet(cortex);
      const managedHome = testCase.managedHome(home);
      const target = path.join(managedHome, ...testCase.targetRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Grafia alternativa documentada do cortex (~/.codex/jarvis-cortex).
      const alias = path.join(home, 'jarvis-cortex-alias');
      fs.symlinkSync(cortex, alias);
      const aliasedTarget = path.join(alias, ...testCase.sourceRelative);
      fs.symlinkSync(aliasedTarget, target);
      assert.ok(fs.existsSync(target), `[${testCase.label}] pré-condição: o alias precisa RESOLVER`);
      assert.strictEqual(fs.readlinkSync(target), aliasedTarget);

      const r = testCase.run(home, {
        script: path.join(cortex, 'scripts', testCase.scriptName),
        cwd: cortex,
      });
      assert.strictEqual(r.code, 0, `[${testCase.label}] falhou:\n${r.stderr}\n${r.stdout}`);

      // A metade que importa: a árvore fonte está intacta, e nada foi espalhado
      // em nenhum outro canto do checkout.
      assertTreeUnchanged(source, sourceBefore, testCase.label);
      assert.deepStrictEqual(diffSets(cortexBefore, entrySet(cortex)),
        { added: [], removed: [], changed: [] },
        `[${testCase.label}] o checkout foi modificado fora da subárvore fonte`);

      // Exceção aplicada: nada parkado sob este nome...
      const base = testCase.targetRelative[testCase.targetRelative.length - 1];
      assert.deepStrictEqual(backupSlots(path.join(managedHome, 'backups'), base), [],
        `[${testCase.label}] o alias físico devia ser re-apontado, não parkado`);
      // ...e o destino agora é um link com a grafia CANÔNICA.
      assert.ok(fs.lstatSync(target).isSymbolicLink(),
        `[${testCase.label}] o destino deixou de ser symlink`);
      assert.strictEqual(fs.readlinkSync(target), source,
        `[${testCase.label}] o alias não foi re-apontado para a grafia canônica`);
      assert.doesNotMatch(r.stdout, new RegExp(`Backed up existing .*${base}`), r.stdout);
    } finally {
      rmHome(home);
      fs.rmSync(cortex, { recursive: true, force: true });
    }
  }
});
