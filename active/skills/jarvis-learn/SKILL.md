---
name: jarvis-learn
description: Extract recurring user corrections from recent sessions and promote them to memory/feedback_*.md. Human-in-the-loop approval. Cortex correction loop (distinct from gstack `learn`).
---

# /jarvis-learn — Loop de aprendizado de correções

Skill de curadoria que varre sessões recentes, identifica correções do usuário, e promove as recorrentes a feedbacks permanentes. Leitura de transcripts privados exige opt-in explícito a cada execução.

## Quando invocar

- Usuário pede: "/jarvis-learn", "roda o jarvis-learn", "aprende das últimas sessões" (no Claude `/learn` é o skill do gstack — este é o loop de correção do cortex)
- Sugerir proativamente: se o usuário mencionar "isso já aconteceu antes" ou "você já fez isso errado" 2+ vezes numa sessão

## Fluxo obrigatório

1. **Scan**
   ```bash
   node active/skills/jarvis-learn/scan.js --allow-private-session-scan --days 7
   ```
   Output é JSON: `{summary, clusters: [{hash, count, occurrences: [...]}]}`.

2. **Apresentar clusters em ordem de frequência** (maior count primeiro).

   Pra cada cluster com `count >= 2` (recorrente) OU `count == 1` explicitamente marcado pelo usuário:
   - Mostrar contagem + datas das ocorrências
   - Mostrar 1 exemplo canônico: texto do usuário + `context` (o que JARVIS fazia quando foi corrigido)
   - Propor draft de feedback com nome + descrição + why + how-to-apply

3. **Aprovação item a item**
   Perguntar: `(a)ceita / (r)ejeita / (e)dita / (s)kip`

4. **Pra aprovados**:
   - Criar `memory/feedback_<slug>.md` com frontmatter:
     ```
     ---
     name: <título curto>
     description: <uma linha>
     type: feedback
     ---

     <regra>

     **Why:** <motivo com referência às ocorrências>

     **How to apply:** <quando aplicar>
     ```
   - Adicionar linha em `MEMORY.md` seção Feedback
   - Commit atômico: `feat: capture feedback — <slug>` (só se usuário pedir push)

5. **Pra rejeitados** (opcional): append em `debug/learn-rejections.log` pra refinar keywords depois.

## Regras

- **Nunca escrever feedback sem aprovação explícita do usuário.** O pipeline `inbox/` anterior foi removido justamente por automação demais (commit 2c7eb71).
- Se `summary.candidates_found == 0`, relatar e parar.
- Se cluster tem 10+ ocorrências do mesmo texto, provável ruído (bug no regex) — flaggar pra revisão em vez de propor feedback.
- Não duplicar feedback existente — antes de escrever, `grep -l` no `memory/feedback_*.md` pra checar overlap.

## Flags do scan

- `--days N` — janela temporal (default 7)
- `--project NAME` — filtra por substring no nome do projeto
- `--projects-dir PATH` — override pro diretório (uso de teste)
- `--allow-private-session-scan` — aprovação explícita para ler `~/.claude/projects`

## Limitações conhecidas

- Regex de correção tem falso-positivo ("não sei" casa "n[aã]o" + próxima palavra). Use julgamento ao revisar.
- Clusterização é hash dos primeiros 80 chars normalizados — variações próximas viram clusters separados.
- Skill depende do formato JSONL dos session transcripts de Claude Code — pode quebrar em versões futuras.
- Sem `--allow-private-session-scan`, o scanner não lê transcripts privados do diretório padrão.
