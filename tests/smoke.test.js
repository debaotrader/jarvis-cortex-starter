#!/usr/bin/env node
/**
 * tests/smoke.test.js — sanity checks estruturais do cortex.
 *
 * Verifica:
 * - Arquivos canônicos existem (BOOT.md, JARVIS.md, CLAUDE.md, MEMORY.md,
 *   SETUP.md, RTK.md, RTK-codex.md)
 * - Cada SKILL.md em active/skills/ e codex/agent-skills/ tem frontmatter
 *   com name: e description:
 * - Skills promovidas têm nomes únicos
 * - Pelo menos um memory/projects/*.md é do tipo project com name
 * - Scripts em scripts/ são executáveis
 * - Cada *.json e *.jsonc no repo é JSONC válido (parser com awareness de
 *   strings, não strip naive de //)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'BOOT.md',
  'JARVIS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'SETUP.md',
  'RTK.md',
  'RTK-codex.md',
];

// === Helpers ===

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function readFrontmatter(file) {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  return content.slice(3, end);
}

function parseFrontmatter(fm) {
  const out = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// Strip JSONC comments com awareness de strings (não quebra // dentro de "...").
// Retorna a string pronta pra JSON.parse.
function stripJsonc(src) {
  let out = '';
  let inString = false;
  let escape = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (escape) { escape = false; }
      else if (c === '\\') { escape = true; }
      else if (c === '"') { inString = false; }
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// === Tests ===

test('[smoke] arquivos canônicos existem', () => {
  for (const f of REQUIRED_FILES) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, f)),
      `Arquivo canônico ausente: ${f}`
    );
  }
});

test('[smoke] active/skills/*/SKILL.md tem name + description', () => {
  const dir = path.join(REPO_ROOT, 'active', 'skills');
  let count = 0;
  for (const f of walk(dir)) {
    if (!f.endsWith(`${path.sep}SKILL.md`)) continue;
    count++;
    const fm = readFrontmatter(f);
    assert.ok(fm, `${f}: sem frontmatter --- ... ---`);
    const meta = parseFrontmatter(fm);
    assert.ok(meta.name, `${f}: frontmatter sem name:`);
    assert.ok(meta.description, `${f}: frontmatter sem description:`);
  }
  assert.ok(count > 0, 'Nenhuma skill em active/skills/');
});

test('[smoke] codex/agent-skills/*/SKILL.md tem name + description', () => {
  const dir = path.join(REPO_ROOT, 'codex', 'agent-skills');
  let count = 0;
  for (const f of walk(dir)) {
    if (!f.endsWith(`${path.sep}SKILL.md`)) continue;
    count++;
    const fm = readFrontmatter(f);
    assert.ok(fm, `${f}: sem frontmatter`);
    const meta = parseFrontmatter(fm);
    assert.ok(meta.name, `${f}: sem name:`);
    assert.ok(meta.description, `${f}: sem description:`);
  }
  assert.ok(count > 0, 'Nenhuma skill em codex/agent-skills/');
});

test('[smoke] skills promovidas têm nomes únicos', () => {
  const dir = path.join(REPO_ROOT, 'active', 'skills');
  const seen = new Map();
  for (const f of walk(dir)) {
    if (!f.endsWith(`${path.sep}SKILL.md`)) continue;
    const meta = parseFrontmatter(readFrontmatter(f));
    if (seen.has(meta.name)) {
      assert.fail(`nome duplicado "${meta.name}" em ${f} e ${seen.get(meta.name)}`);
    }
    seen.set(meta.name, f);
  }
});

test('[smoke] PROMOTED_CORTEX_SKILLS (Codex) bate com promoted list (Claude)', () => {
  // bootstrap-claude.sh symlinks all `active/skills/*` whose name appears in
  // its `for skill_name in ...` list. install-codex-skills.sh uses
  // PROMOTED_CORTEX_SKILLS for the same purpose. The two must agree so
  // a fresh Claude install and a fresh Codex install both get the
  // same set of promoted cortex skills. Drift = silent feature gap.
  const fs = require('node:fs');
  const claudeSh = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'bootstrap-claude.sh'), 'utf8');
  const codexSh  = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install-codex-skills.sh'), 'utf8');

  const claudeMatch = claudeSh.match(/for skill_name in ([^;]+);/);
  const codexMatch  = codexSh.match(/PROMOTED_CORTEX_SKILLS="([^"]+)"/);
  assert.ok(claudeMatch, 'bootstrap-claude.sh: for skill_name in ... não encontrado');
  assert.ok(codexMatch,  'install-codex-skills.sh: PROMOTED_CORTEX_SKILLS="..." não encontrado');

  const claude = new Set(claudeMatch[1].trim().split(/\s+/));
  const codex  = new Set(codexMatch[1].trim().split(/\s+/));

  const missingInCodex = [...claude].filter(s => !codex.has(s));
  const missingInClaude = [...codex].filter(s => !claude.has(s));
  assert.deepStrictEqual(missingInCodex, [], `Skills em Claude bootstrap mas ausentes em Codex install: ${missingInCodex.join(', ')}`);
  assert.deepStrictEqual(missingInClaude, [], `Skills em Codex install mas ausentes em Claude bootstrap: ${missingInClaude.join(', ')}`);
});

test('[smoke] memory/projects/*.md tem pelo menos um project com name+type', (t) => {
  const dir = path.join(REPO_ROOT, 'memory', 'projects');
  // Um cortex recem-clonado nao tem projeto registrado ainda: memory/ nasce
  // vazio de proposito. Isso e o estado inicial esperado, nao um defeito, e
  // falhar aqui daria vermelho no primeiro contato de quem clona o starter.
  // O teste so tem o que afirmar quando existe pelo menos um arquivo.
  const candidatos = fs.existsSync(dir)
    ? [...walk(dir)].filter((f) => f.endsWith('.md'))
    : [];
  if (candidatos.length === 0) {
    t.skip('memory/projects/ vazio: nenhum projeto registrado neste cortex');
    return;
  }
  let found = 0;
  for (const f of walk(dir)) {
    if (!f.endsWith('.md')) continue;
    const fm = readFrontmatter(f);
    if (!fm) continue;
    const meta = parseFrontmatter(fm);
    if (meta.type === 'project' && meta.name) found++;
  }
  assert.ok(found >= 1, 'Nenhum memory/projects/*.md com type=project e name');
});

test('[smoke] scripts/*.sh são executáveis', () => {
  const dir = path.join(REPO_ROOT, 'scripts');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.sh')) continue;
    const p = path.join(dir, f);
    fs.accessSync(p, fs.constants.X_OK);
  }
});

test('[smoke] update-tools deriva o cortex root da própria localização', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'update-tools.sh'), 'utf8');
  const cortexAssignments = script.match(/^\s*CORTEX=.*$/gm) || [];

  assert.ok(
    script.includes('while [ -L "$SCRIPT_SOURCE" ]; do') &&
      script.includes('SCRIPT_DIR="$(cd -P -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd)"'),
    'update-tools.sh deve resolver symlinks e o diretório físico do próprio script'
  );
  assert.deepStrictEqual(
    cortexAssignments,
    ['CORTEX="$(cd -P -- "$SCRIPT_DIR/.." && pwd)"'],
    'update-tools.sh deve ter uma única atribuição portátil de CORTEX'
  );
  assert.ok(
    !script.includes('$HOME/Documents/Codex/jarvis-cortex'),
    'update-tools.sh não pode depender de um clone em caminho fixo'
  );
  assert.ok(
    script.includes('CORTEX_GIT_ROOT=$(git -C "$CORTEX" rev-parse --show-toplevel 2>/dev/null || true)') &&
      script.includes('elif [ "$CORTEX_GIT_ROOT" != "$CORTEX" ]; then'),
    'update-tools.sh deve validar o Git worktree antes de sincronizar'
  );
});

test('[smoke] bash -n em todos os scripts/*.sh passa', () => {
  const dir = path.join(REPO_ROOT, 'scripts');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.sh')) continue;
    const p = path.join(dir, f);
    execFileSync('bash', ['-n', p], { stdio: 'pipe' });
  }
});

test('[smoke] *.json e *.jsonc no repo são JSONC válidos', () => {
  const offenders = [];
  function check(file) {
    const ext = path.extname(file);
    if (ext !== '.json' && ext !== '.jsonc') return;
    const src = fs.readFileSync(file, 'utf8');
    try {
      JSON.parse(stripJsonc(src));
    } catch (err) {
      offenders.push(`${path.relative(REPO_ROOT, file)}: ${err.message}`);
    }
  }
  for (const f of walk(REPO_ROOT)) {
    if (f.includes(`${path.sep}.git${path.sep}`)) continue;
    if (f.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (f.includes(`${path.sep}chroma_db${path.sep}`)) continue;
    check(f);
  }
  assert.deepStrictEqual(offenders, [], `JSONC inválido:\n${offenders.join('\n')}`);
});
