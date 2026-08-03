#!/usr/bin/env node
/**
 * tests/hm-skills.test.js — regressão do provisionamento das skills Higher Mind.
 *
 * As 13 skills HM são cortex-owned, vendoradas em codex/skills-local/hm-*.
 * Elas chegam ao Codex via install-codex-skills.sh (copia todo skills-local),
 * mas só passaram a chegar ao lado Claude depois do loop dedicado em
 * scripts/bootstrap-claude.sh. Esta suíte trava as duas pontas:
 *
 *   1. codex/skills-local/ contém as 13 hm-<name>/SKILL.md (fonte vendorada)
 *   2. bootstrap-claude.sh contra um CLAUDE_HOME temp linka as 13 como symlinks
 *      resolvendo pros dirs vendorados
 *
 * A lista das 13 é HARDCODED de propósito: se o teste derivasse o conjunto do
 * mesmo glob que o script usa, remover um dir vendorado sumiria dos dois lados
 * e o teste passaria mesmo quebrado. Hardcoded → remover hm-cli do skills-local
 * deixa o bootstrap linkar 12 e o teste falha no hm-cli esperado (mutation-proof).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-claude.sh');

// As 13 skills Higher Mind — lista canônica e explícita (ver header).
const HM_SKILLS = [
  'hm-cli',
  'hm-data-integrity',
  'hm-deploy',
  'hm-design',
  'hm-designer',
  'hm-engineer',
  'hm-init',
  'hm-llm-guardrails',
  'hm-performance',
  'hm-qa',
  'hm-security',
  'hm-ux-flow',
  'hm-validate-all',
];

// HOME temp fresco; PATH/TMPDIR preservados. CLAUDE_HOME aninhado no HOME temp
// pro bootstrap não tocar o ~/.claude real. INSTALL_MATTPOCOCK=0 pula o clone
// de rede (opcional, não-fatal) — irrelevante pra provisão das HM.
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hm-'));
}

function runBootstrap(home) {
  const claudeHome = path.join(home, '.claude');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_HOME: claudeHome,
      INSTALL_MATTPOCOCK: '0',
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, claudeHome };
}

test('[hm] codex/skills-local contém as 13 skills HM (fonte vendorada)', () => {
  for (const name of HM_SKILLS) {
    const skillMd = path.join(REPO_ROOT, 'codex', 'skills-local', name, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), `vendorada faltando: codex/skills-local/${name}/SKILL.md`);
  }
});

test('[hm] bootstrap-claude linka as 13 HM no CLAUDE_HOME como symlinks pro skills-local', () => {
  const home = freshHome();
  try {
    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou: ${r.stderr}`);

    for (const name of HM_SKILLS) {
      const target = path.join(r.claudeHome, 'skills', name);
      assert.ok(fs.existsSync(target), `HM não provisionada: ${name}`);
      assert.ok(
        fs.lstatSync(target).isSymbolicLink(),
        `HM ${name} deveria ser symlink, não dir copiado`
      );
      assert.ok(
        fs.existsSync(path.join(target, 'SKILL.md')),
        `HM ${name} symlink não resolve pra um dir com SKILL.md`
      );
      const real = fs.realpathSync(target);
      assert.ok(
        real.endsWith(path.join('codex', 'skills-local', name)),
        `HM ${name} resolve pra ${real}, esperado terminar em codex/skills-local/${name}`
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[hm] re-rodar bootstrap é idempotente (mesmos 13 links, sem .backup*)', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0, 'primeira run falhou');
    const r2 = runBootstrap(home);
    assert.strictEqual(r2.code, 0, 'segunda run falhou');

    const skillsDir = path.join(r2.claudeHome, 'skills');
    const entries = fs.readdirSync(skillsDir);
    const backups = entries.filter((e) => e.includes('.backup'));
    assert.deepStrictEqual(backups, [], `re-run criou backups: ${backups.join(', ')}`);

    for (const name of HM_SKILLS) {
      assert.ok(
        fs.lstatSync(path.join(skillsDir, name)).isSymbolicLink(),
        `HM ${name} deixou de ser symlink após re-run`
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[hm] não clobbera dir HM real do usuário (skip + warn, preserva conteúdo)', () => {
  const home = freshHome();
  try {
    // Pré-stage um hm-cli real (dir, não symlink) com conteúdo do usuário.
    const userSkill = path.join(home, '.claude', 'skills', 'hm-cli');
    fs.mkdirSync(userSkill, { recursive: true });
    const marker = 'USER OWN CONTENT — não deve ser sobrescrito\n';
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), marker);

    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou: ${r.stderr}`);
    assert.match(r.stderr, /hm-cli.*skipping/i, 'sem warn de skip pro hm-cli do usuário');

    // hm-cli continua dir real com o conteúdo original.
    assert.ok(!fs.lstatSync(userSkill).isSymbolicLink(), 'hm-cli foi clobberado pra symlink');
    assert.strictEqual(
      fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8'),
      marker,
      'conteúdo do usuário em hm-cli foi sobrescrito'
    );

    // As outras 12 ainda linkam apesar do skip de uma.
    for (const name of HM_SKILLS.filter((n) => n !== 'hm-cli')) {
      assert.ok(
        fs.lstatSync(path.join(home, '.claude', 'skills', name)).isSymbolicLink(),
        `HM ${name} não foi linkada após skip do hm-cli`
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
