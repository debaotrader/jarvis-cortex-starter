---
name: jarvis-cortex
description: Load the JARVIS cortex in Codex for identity, memory, rules, Jarvis Brain knowledge, project context, and continuity between sessions.
---

# Jarvis Cortex

Use esta skill para operar com o contexto pessoal do dono dentro do Codex.

## Fontes Principais

Caminhos relativos a partir do root do cortex. Descubra o root na ordem do `AGENTS.md`: diretorio do `AGENTS.md` se contiver `JARVIS.md` e `BOOT.md`, senao `~/.codex/jarvis-cortex`.

- Cortex (root): `~/.codex/jarvis-cortex`
- Boot: `BOOT.md`
- Regras inviolaveis: `active/rules/inviolaveis.md`
- Padrao operacional: `active/rules/padrao.md`
- Memoria: `memory/`
- Jarvis Brain: `JARVIS_BRAIN_HOME`, `graphifyBrainPath` no `config.json` local ou `~/.jarvis/brain`.

## Fluxo

1. Leia `BOOT.md` para entender o indice.
2. Leia `active/rules/inviolaveis.md` e `active/rules/padrao.md` quando a tarefa afetar comportamento, codigo, seguranca ou memoria.
3. Leia `MEMORY.md` e o arquivo relevante em `memory/projects/` quando a tarefa envolver um projeto conhecido.
4. Para conhecimento duravel, consulte `graphify-brain`; abra diretamente apenas o Markdown exato citado pelo grafo.
5. Carregue `active/contexts/dev.md` para desenvolvimento e `active/contexts/review.md` para review.

## Cuidados no Codex

- Nao assuma que hooks Claude funcionam igual no Codex.
- Trate skills migradas do Claude/gstack como guia operacional, nao como limite de permissao.
- Mantenha as instrucoes nativas do Codex como prioridade quando houver conflito.
