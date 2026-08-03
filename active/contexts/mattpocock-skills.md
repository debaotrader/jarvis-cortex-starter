# Contexto: Mattpocock Skills

Catálogo de skills externas de `github.com/mattpocock/skills` (MIT). Instaladas por `scripts/install-mattpocock-skills.sh` em `~/.claude/skills/` e `~/.codex/skills/`: as categorias ativas (engineering/productivity/misc) exceto `caveman` (~18 skills — o plugin caveman é o dono do nome). deprecated/in-progress/personal nunca entram.

## Quando carregar este módulo

- User menciona TDD, triage de issues, PRD, prototype, grilling, zoom-out
- Workflow chain: PRD → issues → triage → diagnose → tdd → review
- Conflito de routing (bug → `investigate` ou `diagnose`?)

## Skills NEW (sem overlap, ativar livremente)

| Skill | Trigger | Uso |
|---|---|---|
| `tdd` | "TDD", "red-green-refactor", "test-first" | Loop disciplinado red→green→refactor |
| `to-issues` | "criar tickets", "quebrar em issues" | Plan/PRD → issues no tracker (GitHub/GitLab/local) |
| `to-prd` | "transformar em PRD", "documentar requisitos" | Convo atual → PRD publicado |
| `triage` | "triagem", "processar fila de issues" | State machine: needs-triage → needs-info → ready-for-agent/human → wontfix |
| `zoom-out` | "step back", "ver contexto maior", "perdi o fio" | Recuar do detalhe pra reavaliar direção |
| `prototype` | "prototipar", "throwaway", "explorar design" | UI variants ou terminal app antes de commit |
| `handoff` | "passar pra outro agent", "compactar convo" | Comprime convo em doc de handoff estruturado |
| `teach` | "explicar", "ensinar conceito", "walkthrough didático" | Explica código/conceito em passos didáticos |
| `setup-pre-commit` | "Husky", "pre-commit", "lint-staged" | Setup pre-commit com type-check + test |
| `git-guardrails-claude-code` | "bloquear git push", "git safety hook" | Instala PreToolUse hook bloqueando git destrutivo |
| `grill-with-docs` | "stress-test plan", "challenge contra domínio" | Grilling com CONTEXT.md + ADRs inline |
| `setup-matt-pocock-skills` | (pré-requisito) | Wizard 1ª vez por repo: configura issue tracker + triage labels + domain docs |
| `migrate-to-shoehorn` | (específico shoehorn lib) | Migração utilitária |
| `scaffold-exercises` | "scaffold curso", "criar exercício" | Estrutura de exercícios com lint |

## Skills com OVERLAP (decisão de routing)

| Caso | Default jarvis | Alternativa mattpocock | Quando escolher alt |
|---|---|---|---|
| Bug / erro | `investigate` | `diagnose` | Quando precisa loop disciplinado repro→minimise→hypothesise→instrument; bugs hard ou regressão de perf |
| Brainstorm vazio | `office-hours` | `grill-me` | NUNCA — grill-me é stress-test, não ideação. Manter `office-hours` |
| Stress-test plano existente | (sem default) | `grill-me` / `grill-with-docs` | Quando plano já existe e quer pressioná-lo |
| Criar skill nova | `skill-creator` | `write-a-skill` | Quando quer progressive disclosure + bundled resources estilo mattpocock |
| Refactor arquitetural | `plan-eng-review` | `improve-codebase-architecture` | Quando foco é "deepening de modules" + CONTEXT.md/ADRs (codebase com domain docs maduros) |

## Workflow chain canônico mattpocock

```
office-hours (ideação)
  ↓
to-prd (documentar)
  ↓
grill-with-docs (stress-test contra domínio)
  ↓
to-issues (quebrar em tickets)
  ↓
triage (priorizar fila)
  ↓
diagnose (se bug) | tdd (se feature) | prototype (se design incerto)
  ↓
review → ship
```

## Pré-requisito

Antes de usar `to-issues`/`to-prd`/`triage`/`diagnose`/`tdd`/`improve-codebase-architecture`/`zoom-out` em repo novo:

```
Skill: setup-matt-pocock-skills
```

Cria `docs/agents/{issue-tracker,triage-labels,domain}.md` + bloco `## Agent skills` em CLAUDE.md/AGENTS.md do repo.

## Regras de integração

- Skills mattpocock NÃO substituem rotas existentes de JARVIS.md — apenas adicionam alternativas
- Ambiguidade entre `investigate` vs `diagnose`: default = `investigate` (mais leve); usar `diagnose` quando user pede repro rigorosa ou bug não óbvio
- `setup-matt-pocock-skills` toca CLAUDE.md/AGENTS.md do REPO ATUAL (não global) — sempre confirmar antes
- `git-guardrails-claude-code` instala hook em settings.json — confirmar escopo (project vs global)
- Instaladas as categorias ativas (engineering/productivity/misc) exceto `caveman` (colisão com plugin v1.8.1) — ~18, incluindo `teach`; deprecated/in-progress/personal nunca entram
