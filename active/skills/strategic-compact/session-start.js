#!/usr/bin/env node
/**
 * SessionStart Hook — Re-anchor tier-1 rules after compaction.
 *
 * Fires with matcher 'compact'. Reads inviolaveis.md and outputs it as
 * additionalContext so that compaction can't silently strip inviolable
 * rules from the post-compact session.
 *
 * Does NOT inject padrao.md content — only a pointer. This preserves
 * Option B (terse CLAUDE.md re-injection) while solving Option C
 * (guaranteed tier-1 availability post-compact).
 */

const path = require('path');
const {
  readStdinJson,
  readFile,
  getClaudeDir,
  output,
  log
} = require('./lib/utils');

async function main() {
  // Drain stdin so the process doesn't hang waiting on it
  await readStdinJson({ timeoutMs: 5000 });

  const inviolaveisPath = path.join(getClaudeDir(), 'active', 'rules', 'inviolaveis.md');
  const inviolaveis = readFile(inviolaveisPath);

  if (!inviolaveis || !inviolaveis.trim()) {
    log('[SessionReinforce] inviolaveis.md missing or empty — skipping re-anchor');
    process.exit(0);
  }

  const reAnchor = [
    inviolaveis.trim(),
    '',
    'Se o padrão operacional (standard, design, filosofia) precisar ser revisitado, leia `active/rules/padrao.md`.'
  ].join('\n');

  output({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: reAnchor
    }
  });

  process.exit(0);
}

main().catch(err => {
  log(`[SessionReinforce] Error: ${err.message}`);
  process.exit(0);
});
