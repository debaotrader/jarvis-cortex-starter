# BOOT — Sequencia de Inicializacao Proativa

> **Boot silencioso (obrigatorio):** Carregue tudo em background. NUNCA anuncie "Cortex carregado", "Lendo X.md", "RTK.md nao existe", nem qualquer status de inicializacao. Apenas responda a primeira mensagem do usuario. Arquivos opcionais ausentes (MEMORY.md, napkin.md) = ignorar em silencio.

## A cada nova sessao:

### 1. Carregar Identidade
- Ler o wrapper ativo do runtime — `AGENTS.md` no Codex, `CLAUDE.md` no Claude Code. Em setups sincronizados, esses wrappers podem ser symlinks para este cortex; respeitar o wrapper ativo em vez de hardcodar um runtime.
- Ler `JARVIS.md` — identidade canonica + skill routing + ponteiros
- Ler o RTK do runtime — `RTK-codex.md` no Codex, `RTK.md` no Claude Code. RTK e obrigatorio; se a variante esperada nao existir, registrar a lacuna depois do boot silencioso sem inventar que carregou.
- Ler `active/rules/inviolaveis.md` — regras que nunca podem ser ignoradas
- Ler `active/rules/padrao.md` — padrão de execução (standard, design, workflow, filosofia)

### 2. Carregar Memoria
- Ler `MEMORY.md` se existir (indice de memorias, na raiz do .claude)
- Ler `napkin.md` se existir (runbook do repositorio atual)

> **Memoria automatica:** quando o runtime expuser memoria automatica, use a ferramenta nativa. No Claude Code, o plugin **claude-mem** grava historico de sessoes automaticamente via SQLite.
> Para buscar trabalho de sessoes anteriores no Claude Code: usar `mem-search`, `timeline`, ou `get_observations`. No Codex, usar os mecanismos de memoria/logs expostos pelo runtime quando existirem.
> O diretorio `memory/` continua ativo para **curadoria manual** (feedbacks, decisoes, projetos).
> **Conhecimento duravel:** descubra o Jarvis Brain por `JARVIS_BRAIN_HOME`, `graphifyBrainPath` no `config.json` local ou `~/.jarvis/brain`. Nao carregue o Brain inteiro no boot.

### 3. Carregar Contexto do Projeto (se aplicavel)
- Detectar projeto ativo via diretorio atual
- Para projeto detectado: ler `memory/projects/{projeto}.md` se existir

### 4. Modulos sob demanda
Carregar conforme o contexto da tarefa — NAO carregar tudo no boot:

| Situacao | Modulo a carregar |
|----------|-------------------|
| Delegando para sub-agentes | `active/rules/delegacao.md` |
| Oportunidade de melhoria | `active/rules/proatividade.md` |
| Consulta ao Brain/projetos | `active/rules/conhecimento.md` |
| Modo desenvolvimento | `active/contexts/dev.md` |
| Modo code review | `active/contexts/review.md` |
| Pipeline multi-agente | `active/skills/orchestrate/SKILL.md` |
| Detectando padroes recorrentes | `active/instincts/` |
| Decisao arquitetural, abordagem incerta, stuck | Usar `plan-eng-review` por padrao; se o runtime expuser `advisor()`, chamar advisor apenas como revisor adicional |

### 5. Jarvis Brain (Sob Demanda)
- Conhecimento duravel: consultar primeiro o MCP oficial `graphify-brain`
- Arquivo conhecido: ler somente o Markdown exato em `JARVIS_BRAIN_HOME`
- Fallback: CLI oficial com `--graph "${JARVIS_BRAIN_HOME:-$HOME/.jarvis/brain}/graphify-out/graph.json"`
- Codigo atual e runtime real vencem snapshots do Brain

## Hierarquia de Memoria

```
Camada 1 — memoria automatica do runtime
  └── Claude Code: claude-mem via PostToolUse hook
  └── Codex: logs/memorias expostos pelo runtime, quando disponiveis

Camada 2 — memory/ (curadoria manual)
  └── feedback_*.md — correcoes e preferencias
  └── decisions.md — decisoes tecnicas permanentes
  └── projects/*.md — contexto por projeto

Camada 3 — napkin.md (runbook operacional)
  └── Padroes recorrentes, max 10 por categoria

Camada 4 — active/ (comportamento)
  └── rules/ — regras inviolaveis + enforce.js
  └── contexts/ — modos dev/review
  └── instincts/ — padroes YAML
  └── skills/ — strategic-compact

Camada 5 — Jarvis Brain (conhecimento duravel)
  └── Markdown privado + Graphify oficial via MCP graphify-brain
```

## Ferramentas Externas Disponiveis
- **RTK** — obrigatorio para comandos shell conforme variante do runtime (`RTK-codex.md` no Codex, `RTK.md` no Claude Code). Verificar com `rtk --version`, `rtk gain`, `which rtk`.
- **Firecrawl CLI** — `firecrawl scrape|search|crawl|map`
- **Playwright MCP** — automacao de browser
- **Graphify Brain MCP** — `query_graph`, `get_node`, `get_neighbors`, `shortest_path` e demais tools oficiais da versao instalada

## Ordem de Prioridade
```
Wrapper ativo do runtime (AGENTS.md/CLAUDE.md) > JARVIS.md > RTK do runtime > active/rules/inviolaveis.md > active/rules/padrao.md > napkin > memory/ > memoria automatica do runtime > active/ > Jarvis Brain
```
