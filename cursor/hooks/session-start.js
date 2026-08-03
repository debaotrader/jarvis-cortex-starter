#!/usr/bin/env node
'use strict';

/**
 * Cursor sessionStart — re-ancora regras invioláveis + aponta BOOT do cortex.
 * Resolve paths via realpath deste script (symlink-safe), com fallback em
 * $HOME/.claude.
 */

const fs = require('node:fs');
const path = require('node:path');

function resolveCortexRoot() {
  try {
    const real = fs.realpathSync(__filename);
    return path.resolve(path.dirname(real), '..', '..');
  } catch {
    return null;
  }
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

try { fs.readFileSync(0, 'utf8'); } catch { /* drain stdin */ }

const home = process.env.HOME || '';
const cortex = resolveCortexRoot();
const inviolaveis = [
  cortex && path.join(cortex, 'active', 'rules', 'inviolaveis.md'),
  path.join(home, '.claude', 'active', 'rules', 'inviolaveis.md'),
].filter(Boolean).find((p) => fs.existsSync(p));

const boot = [
  cortex && path.join(cortex, 'BOOT.md'),
  path.join(home, '.claude', 'BOOT.md'),
].filter(Boolean).find((p) => fs.existsSync(p));

const body = inviolaveis ? read(inviolaveis).trim() : '';
if (!body) process.exit(0);

const extra = [
  body,
  '',
  `Harness: Cursor. Cortex root: ${cortex || '~/.codex/jarvis-cortex'}.`,
  'Ao iniciar trabalho substantivo, leia BOOT.md e siga a sequência.',
  boot ? `BOOT disponível: ${boot}` : 'BOOT.md não encontrado — cortex pode estar deslinkado.',
  'Se o padrão operacional precisar ser revisitado, leia `active/rules/padrao.md`.',
].join('\n');

process.stdout.write(JSON.stringify({
  additional_context: extra,
}) + '\n');
process.exit(0);
