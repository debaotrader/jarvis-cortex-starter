# Contexto: Mattpocock Skills

Catálogo de skills externas de `github.com/mattpocock/skills` (MIT). Instaladas por `scripts/install-mattpocock-skills.sh` em `~/.claude/skills/` e `~/.codex/skills/`: as categorias ativas (engineering/productivity/misc) exceto `caveman` (26 skills — o plugin caveman é o dono do nome). deprecated/in-progress/personal nunca entram.

**Este catálogo é válido para `MATTPOCOCK_REF` = `9603c1c`**, o commit fixado no instalador. Upstream renomeia skills sem aviso, e antes do pin este arquivo era infixável por construção: qualquer correção envelhecia na próxima instalação. Ao bumpar o ref, atualize este arquivo no mesmo commit — é a única razão pela qual ele pode estar correto.

Fonte da verdade, sempre: `ls ~/.claude/.cache/mattpocock-skills/skills/{engineering,productivity,misc}`.

## Quando carregar este módulo

- User menciona TDD, triage de issues, spec, tickets, prototype, grilling
- Workflow chain: spec → tickets → triage → diagnóstico → tdd → review
- Conflito de routing (bug → `investigate` ou `diagnosing-bugs`?)

## Skills NEW (sem overlap, ativar livremente)

| Skill | Trigger | Uso |
|---|---|---|
| `tdd` | "TDD", "red-green-refactor", "test-first" | Loop disciplinado red→green→refactor |
| `to-spec` | "transformar em spec", "documentar requisitos" | Convo atual → spec publicada no issue tracker |
| `to-tickets` | "criar tickets", "quebrar em issues" | Plan/spec → tickets tracer-bullet, cada um declarando o que prova |
| `triage` | "triagem", "processar fila de issues" | State machine de papéis: categorise → verify → grill |
| `prototype` | "prototipar", "throwaway", "explorar design" | Protótipo descartável pra responder pergunta de design |
| `wayfinder` | "planejar coisa grande", "não cabe numa sessão" | Mapa compartilhado de decisões pra trabalho maior que uma sessão de agente |
| `implement` | "implementar a spec", "executar os tickets" | Implementa a partir de spec ou conjunto de tickets |
| `resolving-merge-conflicts` | "conflito de merge", "rebase travado" | Resolve conflito de merge/rebase em andamento |
| `domain-modeling` | "linguagem ubíqua", "modelo de domínio", "ADR" | Constrói e afia o modelo de domínio do projeto |
| `codebase-design` | "módulo profundo", "onde fica a costura", "testável" | Vocabulário compartilhado pra desenhar deep modules |
| `handoff` | "passar pra outro agent", "compactar convo" | Comprime convo em doc de handoff estruturado |
| `teach` | "explicar", "ensinar conceito", "walkthrough didático" | Explica código/conceito em passos didáticos |
| `setup-pre-commit` | "Husky", "pre-commit", "lint-staged" | Setup pre-commit com type-check + test |
| `git-guardrails-claude-code` | "bloquear git push", "git safety hook" | Instala PreToolUse hook bloqueando git destrutivo |
| `grill-with-docs` | "stress-test plan", "challenge contra domínio" | Grilling que também produz ADR + glossário |
| `setup-matt-pocock-skills` | (pré-requisito) | Wizard 1ª vez por repo: configura issue tracker + triage labels + domain docs |
| `migrate-to-shoehorn` | (específico shoehorn lib) | Migração utilitária |
| `scaffold-exercises` | "scaffold curso", "criar exercício" | Estrutura de exercícios com lint |
| `ask-matt` | "qual skill uso?", "que fluxo serve aqui?" | Roteador sobre as skills DESTE repo — não sobre as do cortex |

## Skills com OVERLAP (decisão de routing)

| Caso | Default jarvis | Alternativa mattpocock | Quando escolher alt |
|---|---|---|---|
| Bug / erro | `investigate` | `diagnosing-bugs` | Quando precisa loop disciplinado repro→minimise→hypothesise→instrument; bugs hard ou regressão de perf |
| Brainstorm vazio | `office-hours` | `grill-me` | NUNCA — grill-me é stress-test, não ideação. Manter `office-hours` |
| Stress-test plano existente | (sem default) | `grill-me` / `grilling` / `grill-with-docs` | `grill-me` e `grilling` são quase iguais; prefira `grill-with-docs` quando o repo tem domain docs, senão `grilling` |
| Criar skill nova | `skill-creator` | `writing-great-skills` | É REFERÊNCIA de escrita, não wizard. Use junto com `skill-creator`, não no lugar |
| Refactor arquitetural | `plan-eng-review` | `improve-codebase-architecture` | Quando foco é "deepening de modules" + CONTEXT.md/ADRs (codebase com domain docs maduros) |
| Code review | `review` (gstack) / `/code-review` | `code-review` | Praticamente nunca — o do cortex conhece o repo e o gate cross-model. O alt revisa por eixo standards+spec desde um ponto fixo |
| Pesquisa | `research` (gstack) | `research` | **Colisão de nome exata.** O instalado em `~/.claude/skills/research` é o do mattpocock, que captura em Markdown contra fontes primárias |

## Workflow chain canônico mattpocock

```
office-hours (ideação)
  ↓
to-spec (documentar)
  ↓
grill-with-docs (stress-test contra domínio)
  ↓
to-tickets (quebrar em tickets)
  ↓
triage (priorizar fila)
  ↓
diagnosing-bugs (se bug) | tdd (se feature) | prototype (se design incerto)
  ↓
implement → review → ship
```

Para trabalho grande demais pra uma sessão, `wayfinder` entra antes de `to-tickets`.

## Pré-requisito

Antes de usar `to-spec`/`to-tickets`/`triage`/`diagnosing-bugs`/`tdd`/`improve-codebase-architecture` em repo novo:

```
Skill: setup-matt-pocock-skills
```

Cria `docs/agents/{issue-tracker,triage-labels,domain}.md` + bloco `## Agent skills` em CLAUDE.md/AGENTS.md do repo.

## Nomes que MUDARAM no upstream

Rotas antigas deste arquivo que apontavam pra skill inexistente, corrigidas em 08/08/2026. Se encontrar qualquer uma escrita em outro lugar do cortex, está morta:

| morto | vivo |
|---|---|
| `to-issues` | `to-tickets` |
| `to-prd` | `to-spec` |
| `diagnose` | `diagnosing-bugs` |
| `write-a-skill` | `writing-great-skills` |
| `zoom-out` | **sem sucessor** — foi removida. `wayfinder` NÃO é substituta: ela planeja trabalho grande como mapa de decisões, não "recuar pra reavaliar direção" |

## Regras de integração

- Skills mattpocock NÃO substituem rotas existentes de JARVIS.md — apenas adicionam alternativas
- Ambiguidade entre `investigate` vs `diagnosing-bugs`: default = `investigate` (mais leve); usar `diagnosing-bugs` quando user pede repro rigorosa ou bug não óbvio
- `setup-matt-pocock-skills` toca CLAUDE.md/AGENTS.md do REPO ATUAL (não global) — sempre confirmar antes
- `git-guardrails-claude-code` instala hook em settings.json — confirmar escopo (project vs global)
- `ask-matt` roteia só dentro do repo mattpocock. Não use como roteador do cortex; a precedência de skill do JARVIS.md manda
- Colisão de nome: `research` e `code-review` existem nos dois mundos. O que está em `~/.claude/skills/` é o do mattpocock, porque o instalador PARQUEIA o que ocupa o nome
