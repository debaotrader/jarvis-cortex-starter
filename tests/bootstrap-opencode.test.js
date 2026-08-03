#!/usr/bin/env node
/**
 * tests/bootstrap-opencode.test.js — regressão da geração do opencode.jsonc.
 *
 * scripts/bootstrap-opencode.sh gera ~/.config/opencode/opencode.jsonc com um
 * bloco gerenciado (entre markers `// >>> jarvis-managed` e `// <<< jarvis-managed`)
 * contendo instructions, skills.paths e mcp. A suíte nunca executava o script,
 * então regressões no config gerado (reverter RTK-codex.md → RTK.md, quebrar o
 * merge idempotente) passariam batidas.
 *
 * Estes testes rodam o script de verdade contra um HOME temp fresco e validam:
 *   1. JSONC válido (strip de linhas `//` preservando o `//` inline da URL MetaAds)
 *   2. variante RTK: tem RTK-codex.md, NÃO tem RTK.md cru
 *   3. todos os paths em instructions existem em disco
 *   4. merge idempotente: rodar 2x não duplica o bloco
 *   5. (bônus) chave manual antes do marker sobrevive ao bootstrap
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-opencode.sh');

// === Helpers ===

// HOME temp fresco; PATH/TMPDIR preservados (o script usa mktemp/awk/pwd/id).
// HOME por último pra o override vencer.
function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-opencode-'));
}

function runBootstrap(home) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function configPath(home) {
  return path.join(home, '.config', 'opencode', 'opencode.jsonc');
}

// Strip de comentários JSONC removendo SÓ linhas full-`//` (mesma abordagem
// citada no spec). Preserva o `//` inline dentro da URL MetaAds porque aquela
// linha não COMEÇA com `//`.
function stripJsoncLines(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

function parseGenerated(home) {
  const src = fs.readFileSync(configPath(home), 'utf8');
  return JSON.parse(stripJsoncLines(src));
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// === Tests ===

test('[opencode] config gerado é JSONC válido (parse após strip de linhas //)', () => {
  const home = freshHome();
  try {
    const r = runBootstrap(home);
    assert.strictEqual(r.code, 0, `bootstrap falhou: ${r.stderr}`);
    assert.ok(fs.existsSync(configPath(home)), 'opencode.jsonc não foi criado');

    const cfg = parseGenerated(home); // lança se inválido
    assert.ok(cfg && typeof cfg === 'object', 'parse não produziu objeto');

    // O `//` inline da URL MetaAds deve sobreviver ao strip.
    assert.strictEqual(
      cfg.mcp.MetaAds.url,
      'https://mcp.facebook.com/ads',
      'URL MetaAds (com // inline) corrompida pelo strip de comentários'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[opencode] instructions usa RTK-codex.md e NÃO RTK.md cru', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const cfg = parseGenerated(home);

    assert.ok(Array.isArray(cfg.instructions), 'instructions não é array');

    const hasCodex = cfg.instructions.some((p) => p.endsWith('RTK-codex.md'));
    assert.ok(hasCodex, `instructions sem RTK-codex.md: ${JSON.stringify(cfg.instructions)}`);

    // Bare RTK.md = regressão do fix opencode. Paths são absolutos, então a
    // variante crua termina em `/RTK.md`; RTK-codex.md termina em `-codex.md`.
    const hasBareRtk = cfg.instructions.some((p) => p.endsWith('/RTK.md'));
    assert.ok(!hasBareRtk, `instructions contém RTK.md cru (regressão): ${JSON.stringify(cfg.instructions)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[opencode] usa graphify-brain oficial e não mantém o MCP legado', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const cfg = parseGenerated(home);
    assert.ok(cfg.mcp['graphify-brain'], 'graphify-brain ausente');
    assert.match(cfg.mcp['graphify-brain'].command.join(' '), /graphify-mcp --graph/);
    assert.ok(!cfg.mcp['obsidian-rag'], 'MCP legado ainda presente');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[opencode] todo path em instructions existe em disco', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0);
    const cfg = parseGenerated(home);

    // instructions aponta pro CORTEX_ROOT real (derivado do local do script,
    // não do HOME), logo os arquivos existem. skills.paths NÃO entra aqui:
    // contém $HOME/.claude/skills que expande pro HOME temp e não existe.
    for (const p of cfg.instructions) {
      assert.ok(fs.existsSync(p), `instruction path inexistente: ${p}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[opencode] merge idempotente: rodar 2x não duplica o bloco gerenciado', () => {
  const home = freshHome();
  try {
    assert.strictEqual(runBootstrap(home).code, 0, 'primeira run falhou');
    assert.strictEqual(runBootstrap(home).code, 0, 'segunda run falhou');

    const src = fs.readFileSync(configPath(home), 'utf8');
    // Markers contados separadamente: ambos contêm "jarvis-managed", então
    // contar só esse substring daria 2 (sinal errado).
    assert.strictEqual(countOccurrences(src, '>>> jarvis-managed'), 1, 'marker START duplicado');
    assert.strictEqual(countOccurrences(src, '<<< jarvis-managed'), 1, 'marker END duplicado');

    // Ainda parseia depois do merge.
    assert.doesNotThrow(() => JSON.parse(stripJsoncLines(src)), 'config inválido após 2 runs');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('[opencode] chave manual antes do marker sobrevive ao bootstrap', () => {
  const home = freshHome();
  try {
    // 1ª run cria o bloco gerenciado com os markers que o awk reconhece.
    assert.strictEqual(runBootstrap(home).code, 0);

    // Injeta chave manual logo após o `{` de abertura, COM vírgula final
    // (o bloco gerenciado começa em "instructions" e não fornece a vírgula).
    const file = configPath(home);
    const original = fs.readFileSync(file, 'utf8');
    const withManual = original.replace('{\n', '{\n  "theme": "jarvis-test-theme",\n');
    assert.notStrictEqual(withManual, original, 'injeção da chave manual falhou (sem `{` no início)');
    fs.writeFileSync(file, withManual);

    // 2ª run regenera só o bloco gerenciado; a chave manual deve sobreviver.
    assert.strictEqual(runBootstrap(home).code, 0);

    const cfg = parseGenerated(home);
    assert.strictEqual(cfg.theme, 'jarvis-test-theme', 'chave manual perdida no merge');
    // Bloco gerenciado segue intacto.
    assert.ok(Array.isArray(cfg.instructions) && cfg.instructions.length > 0, 'bloco gerenciado sumiu');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
