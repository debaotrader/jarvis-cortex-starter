#!/usr/bin/env node
/**
 * tests/mattpocock-context.test.js — mantém active/contexts/mattpocock-skills.md
 * de acordo com o que o ref fixado realmente entrega.
 *
 * Esse arquivo de routing ficou meses nomeando cinco skills que não existiam
 * (`to-issues`, `to-prd`, `diagnose`, `write-a-skill`, `zoom-out`) enquanto
 * treze skills vivas não tinham rota nenhuma. Ninguém percebeu porque nada
 * comparava o documento com a realidade — e antes de MATTPOCOCK_REF ser
 * fixado, comparar não adiantaria: o upstream se movia entre uma instalação e
 * a seguinte.
 *
 * Agora o ref é fixo, então o documento PODE estar certo e este teste cobra
 * isso nos dois sentidos: nada citado que não exista, nada existente sem
 * citação.
 *
 * O clone é cache local, não é versionado. Sem ele o teste PULA em vez de
 * falhar — um teste que exige rede transforma "sem internet" em "código
 * quebrado".
 *
 * Run: node --test tests/mattpocock-context.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTEXT_DOC = path.join(REPO_ROOT, 'active', 'contexts', 'mattpocock-skills.md');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-mattpocock-skills.sh');

// As mesmas categorias que o instalador trata como ativas, e a mesma exclusão.
const ACTIVE_CATEGORIES = ['engineering', 'productivity', 'misc'];
const EXCLUDED = new Set(['caveman']);

// Skills que o documento cita de propósito e que NÃO vêm do mattpocock: são do
// cortex ou do gstack, e aparecem na tabela de overlap para resolver ambiguidade.
const FOREIGN_SKILLS = new Set([
  'investigate', 'office-hours', 'skill-creator', 'plan-eng-review', 'review', 'ship',
]);

function cacheDir() {
  return process.env.MATTPOCOCK_CACHE
    || path.join(os.homedir(), '.claude', '.cache', 'mattpocock-skills');
}

function installedSkills() {
  const root = path.join(cacheDir(), 'skills');
  if (!fs.existsSync(root)) return null;
  const found = new Set();
  for (const category of ACTIVE_CATEGORIES) {
    const dir = path.join(root, category);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      // Mesmo critério do instalador: só conta diretório com SKILL.md dentro.
      if (!fs.existsSync(path.join(dir, entry, 'SKILL.md'))) continue;
      if (EXCLUDED.has(entry)) continue;
      found.add(entry);
    }
  }
  return found;
}

// Nomes em crase que parecem nome de skill. O filtro por forma evita capturar
// SHA, caminho e variável de ambiente, que também aparecem em crase no doc.
function quotedNames(markdown) {
  const names = new Set();
  for (const match of markdown.matchAll(/`([a-z][a-z0-9-]{2,})`/g)) {
    const name = match[1];
    if (/^[0-9a-f]{7,40}$/.test(name)) continue;   // SHA
    if (name.includes('/') || name.includes('.')) continue;
    names.add(name);
  }
  return names;
}

// A tabela "Nomes que MUDARAM no upstream" existe para registrar rota morta de
// propósito. O que estiver na coluna da esquerda dela não conta como citação.
function declaredDead(markdown) {
  const dead = new Set();
  const section = markdown.split(/^## Nomes que MUDARAM no upstream$/m)[1];
  if (!section) return dead;
  for (const match of section.split(/^## /m)[0].matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)) {
    dead.add(match[1]);
  }
  return dead;
}

test('[mattpocock] o doc de routing não cita skill que não existe no ref fixado', (t) => {
  const installed = installedSkills();
  if (installed === null || installed.size === 0) {
    t.skip(`clone mattpocock ausente em ${cacheDir()} — rode scripts/install-mattpocock-skills.sh`);
    return;
  }
  const markdown = fs.readFileSync(CONTEXT_DOC, 'utf8');
  const dead = declaredDead(markdown);
  assert.ok(dead.size > 0, 'a tabela de nomes mortos sumiu do doc; ela é parte do contrato');

  const bogus = [...quotedNames(markdown)].filter((name) => (
    !installed.has(name) && !FOREIGN_SKILLS.has(name) && !dead.has(name) && !EXCLUDED.has(name)
  ));
  assert.deepStrictEqual(
    bogus, [],
    `active/contexts/mattpocock-skills.md roteia por skill inexistente: ${bogus.join(', ')}.\n`
    + 'Confira o clone e corrija o doc, ou declare o nome na tabela "Nomes que MUDARAM no upstream".',
  );
});

test('[mattpocock] toda skill do ref fixado tem menção no doc de routing', (t) => {
  const installed = installedSkills();
  if (installed === null || installed.size === 0) {
    t.skip(`clone mattpocock ausente em ${cacheDir()}`);
    return;
  }
  const markdown = fs.readFileSync(CONTEXT_DOC, 'utf8');
  const mentioned = quotedNames(markdown);
  const missing = [...installed].filter((name) => !mentioned.has(name)).sort();
  assert.deepStrictEqual(
    missing, [],
    `skills instaladas sem rota no doc: ${missing.join(', ')}.\n`
    + 'Uma skill sem rota é invisível para o agente — adicione, nem que seja para dizer que não se usa.',
  );
});

test('[mattpocock] o doc declara o mesmo ref que o instalador fixa', (t) => {
  const installerSource = fs.readFileSync(INSTALLER, 'utf8');
  const pin = installerSource.match(/MATTPOCOCK_REF="\$\{MATTPOCOCK_REF:-([0-9a-f]{40})\}"/);
  assert.ok(pin, 'install-mattpocock-skills.sh deixou de fixar um SHA em MATTPOCOCK_REF');

  const markdown = fs.readFileSync(CONTEXT_DOC, 'utf8');
  // O doc cita a forma curta; um prefixo do SHA longo é o que amarra os dois.
  const shortRefs = [...markdown.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]);
  assert.ok(
    shortRefs.some((ref) => pin[1].startsWith(ref)),
    `o doc não cita o ref fixado (${pin[1].slice(0, 7)}). Bumpar MATTPOCOCK_REF e atualizar `
    + 'active/contexts/mattpocock-skills.md pertencem ao mesmo commit.',
  );
});
