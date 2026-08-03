# Setup — Jarvis Cortex

## Pré-requisitos do sistema

Antes de rodar `install.sh`/bootstrap, uma máquina nova precisa destas ferramentas
base no PATH. Os comandos assumem [Homebrew](https://brew.sh) instalado.

- **`node` (>=20) + `git`** — obrigatórios. Os hooks (`enforce.js`, `suggest-compact.js`,
  `pre-compact.js`, `session-start.js`) e os testes (`node tests/run-all.js`) não rodam
  sem `node`. O `doctor.sh` é bash e **roda mesmo sem node**: reporta a ausência como
  FAIL, pula os checks que dependem dele e sai não-zero.
  ```bash
  brew install node git
  ```
- **`rtk`** — obrigatório. O Rust Token Killer roda em **todo** comando Bash via hook
  PreToolUse (`rtk hook claude`) — regra inviolável, nunca desabilitar.
  ```bash
  brew install rtk
  ```
  Cuidado com colisão de nome: o correto é o `rtk` do homebrew-core (rtk-ai.app).
  Confirme com `rtk gain` funcionando e `which rtk`; se `rtk gain` falhar ou o path
  parecer errado, você instalou `reachingforthejack/rtk` (Rust Type Kit) por engano.
- **`codex` CLI** — necessário para o harness Codex e para o re-review obrigatório do
  `loop-hermes` no Claude Code. É um pacote npm.
  ```bash
  npm install -g @openai/codex
  ```
- **`graphify` e `graphify-mcp`** — obrigatorios para o Brain privado. Instale a versao validada do pacote `graphifyy[mcp]`.
- **`bun`** — obrigatório no `PATH` sempre que as skills do gstack forem instaladas
  no Cursor ou no Codex. O Cursor executa entrypoints TypeScript com `bun run`; o
  passo `./setup` do gstack no Codex também precisa de `bun`.
  ```bash
  brew install bun
  ```
  No **Codex** o setup do gstack é **best-effort**: baixa ~250MB de browsers do
  Playwright e pode emitir warnings upstream. O passo roda em subshell não-fatal, então
  sua falha (clone, pull ou `./setup`) só emite um warn e **não bloqueia** a instalação
  das skills do cortex — as promovidas são linkadas de qualquer forma.
  No **Cursor** é fatal: se o manifesto de skills tiver qualquer linha gstack e `bun`
  não estiver no PATH, o `bootstrap-cursor.sh` **sai 1** antes da primeira mutação.

Com os pré-requisitos no lugar, rode `scripts/install.sh` e depois `scripts/doctor.sh`
(detalhado abaixo).

## Fontes das dependências (manifesto)

Tudo que vive FORA do git, com a fonte exata e a versão conhecida-boa. Os
plugins do Claude Code se auto-instalam no launch porque a fonte está em
`settings.json` → `extraKnownMarketplaces`; o resto instala-se pelos comandos abaixo.

### Ferramentas de sistema (binários no PATH)
| Ferramenta | Fonte / comando | Versão boa |
|---|---|---|
| node + git | `brew install node git` | node >=20 |
| rtk | `brew install rtk` (homebrew-core — https://www.rtk-ai.app) | 0.42.3 |
| codex CLI | `npm install -g @openai/codex` | 0.130.0 |
| graphify + graphify-mcp | `uv tool install --python 3.12 "graphifyy[mcp]==0.9.11"` | 0.9.11 |
| bun (com gstack) | `brew install bun` — obrigatório para o runtime gstack no Cursor e para o `./setup` no Codex | — |
| gstack (skills) | `git clone https://github.com/garrytan/gstack.git` | — |
| mattpocock (skills) | `git clone https://github.com/mattpocock/skills.git` (MIT) — instalado por `scripts/install-mattpocock-skills.sh` (best-effort, não-fatal, precisa de git + rede). Symlinka só as categorias ativas (engineering/productivity/misc); `caveman` é pulado (o plugin caveman é o dono) e deprecated/in-progress/personal nunca entram | — |
| ruflo (opcional) | `npm install -g ruflo` | — |

### Plugins Claude Code (auto-install via `settings.json`)
| Plugin | Fonte (marketplace) |
|---|---|
| `caveman@caveman` | github `JuliusBrussee/caveman` |
| `claude-mem@thedotmack` | github `thedotmack/claude-mem` |
| `n8n-to-langgraph` | git `github.com/fazer-ai/n8n-to-langgraph` |
| `n8n-mcp-skills` | github `czlonkowski/n8n-skills` |
| `codex@openai-codex` | github `openai/codex-plugin-cc` |

### MCP servers
| MCP | Onde é registrado | Fonte / comando |
|---|---|---|
| graphify-brain | **não** fica em `settings.json`: o `scripts/setup-graphify-brain.sh` roda `claude mcp add --scope user` e `codex mcp add` | local oficial — `graphify-mcp --graph <brain>/graphify-out/graph.json` |
| playwright | `settings.json` → `mcpServers` | `npx @playwright/mcp@0.0.68` |
| n8n | `settings.json` → `mcpServers` | `npx -y n8n-mcp-server@0.1.0` |
| MetaAds | `settings.json` → `mcpServers` | remoto — `https://mcp.facebook.com/ads` |

## Instalação rápida (qualquer máquina)

Clone o cortex em um path local estável e rode o instalador unificado. Ele
deriva o root do próprio script — não precisa editar path nenhum, e funciona
em qualquer path de clone.

```bash
git clone https://github.com/debaotrader/jarvis-cortex-starter.git ~/.codex/jarvis-cortex
git clone https://github.com/YOUR-USER/jarvis-brain.git ~/.jarvis/brain
~/.codex/jarvis-cortex/scripts/install.sh           # todos os harnesses (claude + codex + opencode + cursor)
```

`install.sh` roda o bootstrap de cada harness e, no fim, o health check
`scripts/doctor.sh`. Quer só um harness:

```bash
~/.codex/jarvis-cortex/scripts/install.sh claude    # só Claude Code
~/.codex/jarvis-cortex/scripts/install.sh codex     # só Codex (exige `codex` no PATH)
~/.codex/jarvis-cortex/scripts/install.sh opencode  # só opencode
~/.codex/jarvis-cortex/scripts/install.sh cursor    # só Cursor IDE
```

Com `all`, três coisas fazem um harness inteiro ser pulado (anunciado, e o resto
segue): `node` fora do PATH pula o Cursor; o CLI `codex` fora do PATH pula o Codex;
e o `bootstrap-opencode.sh` saindo **3** — recusa deliberada, nada escrito — pula o
opencode. Qualquer outro status não-zero é falha inesperada e aborta até no `all`.
No modo explícito (`install.sh cursor`, `install.sh codex`, `install.sh opencode`)
cada um falha alto em vez de pular. É idempotente — re-rodar é seguro.

Verificação pós-install (read-only, exit 0 = saudável):

```bash
~/.codex/jarvis-cortex/scripts/doctor.sh
```

`doctor.sh` checa symlinks, hooks, plugins, OpenCode, Brain, grafo, politica de
hooks Git e registros `graphify-brain` nos runtimes presentes. Honra
`HOME`/`CLAUDE_HOME`/`CODEX_HOME`/`CURSOR_HOME`/`JARVIS_BRAIN_HOME`. O
`install.sh` roda o doctor por último em **todo** modo, não só no `all`, e o exit
code do doctor é o exit code do `install.sh`.

As seções abaixo detalham cada bootstrap individualmente, caso queira rodá-los
direto em vez de via `install.sh`.

## Claude Code no macOS

Clone o cortex em um path local estável e rode o bootstrap do Claude:

```bash
git clone https://github.com/debaotrader/jarvis-cortex-starter.git ~/.codex/jarvis-cortex
~/.codex/jarvis-cortex/scripts/bootstrap-claude.sh
```

O bootstrap:
- linka `~/.claude/CLAUDE.md` para o `CLAUDE.md` versionado deste repo
- linka `~/.claude/JARVIS.md` para o `JARVIS.md` versionado deste repo
- linka `~/.claude/RTK.md` para o `RTK.md` versionado deste repo
- linka `BOOT.md`, `MEMORY.md`, `active/`, `memory/`, `commands/`, `docs/`, `scripts/`, `napkin.md` e `settings.json`
- linka as skills promovidas do cortex que não vêm do gstack por padrão: `dead-code-audit`, `impeccable`, `loop-hermes`, `orchestrate`, `security-audit`, `strategic-compact`, `verification-loop`, `jarvis-learn`; o build Claude do `impeccable` fica em `active/claude-skills/impeccable`
- preserva `learn` do gstack em `~/.claude/skills/learn`; o loop de correções do cortex foi renomeado pra `jarvis-learn` e é linkado em `~/.claude/skills/jarvis-learn` (sem colisão)
- instala as skills mattpocock via `scripts/install-mattpocock-skills.sh` (best-effort, não-fatal — precisa de git + rede; falha só emite warn e segue). Symlinka as categorias ativas (engineering/productivity/misc) menos `caveman` (plugin caveman é o dono); deprecated/in-progress/personal nunca entram. Desligue com `INSTALL_MATTPOCOCK=0`
- linka as 13 skills Higher Mind (HM), vendoradas em `codex/skills-local/hm-*` (`hm-cli`, `hm-data-integrity`, `hm-deploy`, `hm-design`, `hm-designer`, `hm-engineer`, `hm-init`, `hm-llm-guardrails`, `hm-performance`, `hm-qa`, `hm-security`, `hm-ux-flow`, `hm-validate-all`), em `~/.claude/skills/hm-<nome>`. Cortex-owned e fatal-safe (não best-effort): um dir HM real já existente do usuário é pulado com warn, nunca sobrescrito
- não linka `config.json` e não copia `settings.local.json`, `.credentials.json`, tokens, logs, sessões, caches ou bancos locais

O `settings.json` é portátil: hooks e `customSystemPrompt` usam `$HOME`/`$CLAUDE_HOME`
(ex: `~/.claude/BOOT.md`), então **não precisa editar path à mão**. O plugin
`codex@openai-codex` (re-review obrigatório do `loop-hermes`) e os demais plugins
habilitados auto-instalam no primeiro launch do Claude Code, porque o marketplace
está registrado em `settings.json`.

A statusLine do caveman é a única exceção que precisa de um segundo passo: o plugin
caveman só instala no **primeiro launch** do Claude Code, depois do bootstrap. Re-rode
`scripts/install.sh claude` (ou `bootstrap-claude.sh`) uma vez após esse primeiro launch
para linkar a statusLine. Até lá ela fica inativa — `doctor.sh` reporta isso como WARN,
não FAIL.

Verificar RTK no Claude:

```bash
rtk --version
rtk gain
which rtk
```

## Cursor IDE no macOS

```bash
~/.codex/jarvis-cortex/scripts/bootstrap-claude.sh   # opcional, somente se também usa Claude Code
~/.codex/jarvis-cortex/scripts/bootstrap-cursor.sh
# ou:
~/.codex/jarvis-cortex/scripts/install.sh cursor     # hooks, MCP, rules e skills nativas
```

O bootstrap Cursor (honra `CURSOR_HOME`, default `~/.cursor`):
- linka `cursor/hooks/*.js` em `$CURSOR_HOME/hooks/`
- faz merge idempotente de `$CURSOR_HOME/hooks.json` (preserva hooks manuais)
- faz merge de `$CURSOR_HOME/mcp.json` com `graphify-brain`, playwright, n8n, MetaAds (preserva MCPs com outros nomes; se um managed key já existir customizado, avisa e salva backup antes de sobrescrever)
- linka a rule always-on `rules/jarvis-cortex.mdc`
- reconcilia um manifesto nativo e curado em `$CURSOR_HOME/skills/`: cortex promovidas, Higher Mind, caveman e, quando o source existe em `~/.gstack/repos/gstack`, cópias Cursor-rendered somente das folhas geradas do gstack; o runtime fica fora da árvore indexada em `$CURSOR_HOME/jarvis-runtime/gstack`, com marker, symlink gerenciado `source` para o repo completo e launcher `pair-agent`, todos validados por ownership e proveniência exata; o launcher isola `pair-agent --local cursor` com um HOME privado e credenciais/marcadores graváveis ficam no diretório irmão `gstack-state`, nunca na árvore indexada nem no checkout source
- usa `scripts/cursor-skill-catalog.mjs` como catálogo único de nome, source, modo e proveniência para gerar o manifesto e autorizar reconciliação; remoção futura de link gerenciado exige tombstone explícita nesse catálogo, com a identidade histórica exata, nunca inferência por namespace
- só aceita `previous_source` para repoint de symlink quando nome, modo e proveniência ainda coincidem com o catálogo e o mesmo source relativo existe num checkout Jarvis antigo fisicamente válido; registros pendentes, trocados ou não verificáveis são preservados e excluídos do manifesto instalado
- aplica a mesma tupla completa a cópias Impeccable/gstack e exige que o `name` do frontmatter imediato seja idêntico ao nome do manifesto no source, staging e target instalado; as folhas gstack usam seu nome canônico de frontmatter, mantendo o source leaf `gstack-*` registrado separadamente
- instala o Impeccable numa cópia Cursor-rendered sob `$CURSOR_HOME/skills/impeccable`, com comandos relativos ao runtime Cursor e sem depender de `~/.claude` ou `~/.agents`
- preserva qualquer skill real do usuário com o mesmo nome; não cria backups dentro da árvore de skills, porque o scanner do Cursor os indexaria como skills adicionais
- no Cursor, desligue **Include Third-Party Plugins, Skills, and Other Configs** em Settings → Rules, Skills and Subagents. O bootstrap consulta essa preferência de forma read-only; se ela não estiver explicitamente `false`, o doctor falha com a remediação. Isso impede que `~/.claude/skills`, `~/.codex/skills` e backups de outros agentes sejam importados recursivamente e duplicados
- o IDE e o `cursor-agent` usam o manifesto nativo em `$CURSOR_HOME/skills/`; nenhuma skill do Cursor depende de `~/.claude/skills`
- integra o Jarvis Brain pelo servidor `graphify-brain` no `mcp.json` gerenciado; não executa instaladores externos que possam escrever fora de `CURSOR_HOME`

Depois do bootstrap, recarregue o Cursor (`Cmd+Shift+P` → Reload Window) para
MCP e hooks nativos entrarem.
## pxpipe (opcional)

`pxpipe` e um proxy local para reduzir tokens de entrada renderizando contexto pesado como PNG. Ele e lossy para strings exatas, entao fica instalado mas nao e ligado automaticamente. No Jarvis ele e Claude-only, com allowlist padrao `claude-fable-5`; Codex roda normalmente sem o proxy.

```bash
~/.codex/jarvis-cortex/scripts/install-pxpipe.sh
~/.codex/jarvis-cortex/scripts/pxpipe.sh start
```

Em outro terminal:

```bash
~/.codex/jarvis-cortex/scripts/pxpipe.sh claude
~/.codex/jarvis-cortex/scripts/pxpipe.sh stats
```

Para o Claude.app no macOS, rode `scripts/pxpipe.sh claude-app-on`, reinicie o app e mantenha o proxy rodando. Para desfazer: `scripts/pxpipe.sh claude-app-off`.

Smoke test controlado:

```bash
~/.codex/jarvis-cortex/scripts/pxpipe.sh claude -p --model fable --no-session-persistence --max-budget-usd 0.05 "Reply exactly PXPIPE_CLAUDE_OK. Do not use tools."
~/.codex/jarvis-cortex/scripts/pxpipe.sh stats
```

Qualquer modelo que nao comece com `claude-` em `PXPIPE_MODELS` e recusado pelo wrapper. `claude-opus-4-8` tem degradacao documentada na leitura das imagens e tambem e bloqueado quando adicionado manualmente. Apenas para experimento consciente com Opus, use `PXPIPE_ALLOW_DEGRADED_MODELS=1`; nao use esse override em seguranca, migracoes, dados financeiros ou tarefas que dependem de IDs, hashes e numeros exatos.

No Claude, `claude-fable-5` testa o caminho comprimido com o login normal do Claude Code. Aumente `--max-budget-usd` apenas de forma consciente em setups com system prompt grande.

O dashboard e `stats` usam o log local `~/.pxpipe/events.jsonl`; `stats` continua mostrando o historico com o proxy parado. Mantenha o proxy opt-in: contexto renderizado como imagem pode perder strings exatas, como IDs e hashes.

## Codex no macOS

Clone o cortex no home do Codex:

```bash
mkdir -p ~/.codex
git clone https://github.com/debaotrader/jarvis-cortex-starter.git ~/.codex/jarvis-cortex
~/.codex/jarvis-cortex/scripts/bootstrap-codex.sh
```

O bootstrap:
- linka `~/.codex/AGENTS.md` para o `AGENTS.md` versionado deste repo
- linka `~/.codex/RTK.md` para `RTK-codex.md`
- exige Codex com o recurso `hooks` ativo e RTK capaz de reescrever `git status` automaticamente
- linka `~/.codex/hooks.json` para `codex/hooks.json` (guard do Jarvis + adaptador do RTK no PreToolUse de Bash)
- no primeiro start, revise e confie o hook em `/hooks`; o Codex vincula a confianca ao hash e exige nova revisao quando a definicao muda
Na ordem real de execução (externos opcionais primeiro, skills do cortex por último):
- instala as skills locais exportadas em `codex/skills-local/` (inclui as 13 skills Higher Mind `hm-*`, vendoradas no repo)
- instala/atualiza o marketplace `karpathy-skills` (best-effort, não-fatal)
- converte o `.claude-plugin` upstream do Karpathy para `.codex-plugin`
- instala a skill `karpathy-guidelines` tambem em `~/.codex/skills`
- clona/atualiza o source do `gstack` em `~/.gstack/repos/gstack`, cria o runtime minimo em `~/.codex/skills/gstack` e linka as skills `gstack-*` em `~/.codex/skills` (best-effort, não-fatal — sua falha não bloqueia o resto)
- linka as skills promovidas do cortex (sempre, por último, mesmo se karpathy/gstack falharem): `dead-code-audit`, `impeccable`, `loop-hermes`, `orchestrate`, `security-audit`, `strategic-compact`, `verification-loop`, `jarvis-learn`; `impeccable` tambem e exposta em `~/.agents/skills/impeccable`
- instala as skills mattpocock em `~/.codex/skills` via `scripts/install-mattpocock-skills.sh` (best-effort, não-fatal; categorias ativas menos `caveman`; desligue com `INSTALL_MATTPOCOCK=0`)
- nao copia `config.toml`, `auth.json`, tokens, logs ou bancos locais

Detalhes de skills: [`docs/codex-skills-macbook.md`](docs/codex-skills-macbook.md).

Instalar MCPs do Codex no Mac:

```bash
read -rsp "N8N key: " N8N_API_KEY; echo
export N8N_API_URL="https://n8n.example.com/api/v1"
read -rsp "TestSprite key: " TESTSPRITE_API_KEY; echo
export N8N_API_KEY TESTSPRITE_API_KEY
~/.codex/jarvis-cortex/scripts/install-codex-mcps.sh
```

Detalhes: [`docs/codex-mcps-macbook.md`](docs/codex-mcps-macbook.md).

Atualizar depois:

```bash
cd ~/.codex/jarvis-cortex
git pull
./scripts/bootstrap-codex.sh
```

Atualizar so o plugin Karpathy:

```bash
~/.codex/jarvis-cortex/scripts/update-karpathy-skills.sh
```

## Ao clonar em nova máquina

O `install.sh` (acima) cobre o caminho principal sem nenhuma edição de path. Os
passos abaixo são **opcionais** e só entram conforme o que você usa nessa máquina.

1. **Jarvis Brain** — clone o repositorio privado no path padrao ou configure
   `JARVIS_BRAIN_HOME`/`graphifyBrainPath`, depois registre o MCP oficial:
   ```bash
   git clone https://github.com/YOUR-USER/jarvis-brain.git ~/.jarvis/brain
   ~/.codex/jarvis-cortex/scripts/setup-graphify-brain.sh --all
   ```
2. **Dependências externas** — instalar conforme a seção "Dependências Externas" abaixo
   (gstack etc.).
3. **MCPs do Codex (opcional)** — `scripts/install-codex-mcps.sh` (precisa de API keys;
   ver seção Codex).
4. **Plugins do Claude** — auto-instalam no primeiro launch porque os marketplaces estão
   registrados em `settings.json`: `claude-mem` (memória automática), `codex@openai-codex`
   (review + re-review obrigatório do `loop-hermes` no Claude Code), `n8n-to-langgraph`
   (conversão de workflows n8n). Sem edição manual.
5. **Verificar tudo** — `scripts/doctor.sh`. Se quiser checar os hooks isoladamente:
   - `echo '{}' | node active/rules/enforce.js` — deve sair **2** com
     `[Enforce] Missing or unusable tool_name — blocking as fail-closed` no stderr.
     Payload sem `tool_name` utilizável falha FECHADO por design; use
     `echo '{"tool_name":"Bash"}'` pra ver o caminho silencioso de exit 0
   - `echo '{}' | node active/rules/enforce-codex.js` — deve sair silencioso (o guard
     do Codex não tem gate por `tool_name`: extrai paths e comandos do payload
     independentemente do nome da ferramenta)
   - `echo '{}' | node active/skills/strategic-compact/pre-compact.js` — deve logar no stderr

## Dependências Externas

Estes componentes vivem FORA do git. Instalar após clone.

### gstack (Skills Framework — by Garry Tan)

**Codex e Cursor não precisam deste passo.** O `scripts/install-codex-skills.sh`
clona/atualiza o gstack em `~/.gstack/repos/gstack` e roda o `./setup --host
codex --no-prefix` de lá (pulado com mensagem se `bun` faltar). O Cursor lê esse
mesmo checkout — `GSTACK_REPO_ROOT`, mesmo default — pra gerar as cópias
`gstack-copy`. Um checkout gstack antigo direto em `~/.codex/skills/gstack` é
parqueado num slot de backup, nunca apagado. Todo o bloco é best-effort: falha
de clone, pull ou `./setup` só emite warn.

Só o harness Claude Code quer um clone próprio:
```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup
```
Atualizar: `/gstack-upgrade` ou `cd ~/.claude/skills/gstack && git pull && ./setup`

### ruflo (Multi-Agent Orchestration — by RuvNet)
```bash
npm i -g ruflo
```
Atualizar: `npm update -g ruflo`

### Skills Anthropic (Marketplace)
Sincronizam automaticamente no primeiro launch do Claude Code. Sem ação manual.

### Plugins (Marketplace)
Auto-sync no primeiro launch do Claude Code. Inclui ralph-loop, math-olympiad, etc.

## Estrutura

```
TRACKED (core JARVIS — versionado no git):
├── BOOT.md              — sequência de inicialização
├── JARVIS.md            — identidade canônica (fonte única dos wrappers)
├── CLAUDE.md            — wrapper Claude Code (importa JARVIS.md + RTK.md)
├── AGENTS.md            — wrapper Codex CLI (importa JARVIS.md + RTK-codex.md)
├── MEMORY.md            — índice de memórias
├── SETUP.md             — este arquivo
├── napkin.md            — runbook operacional curado
├── settings.json        — hooks, MCP servers, config
├── .gitignore           — fronteira tracked/vendor/ephemeral
├── .gitattributes       — normalização CRLF
├── active/              — módulos carregados sob demanda
│   ├── rules/           — regras + enforce.js
│   ├── contexts/        — modos (dev, review)
│   ├── instincts/       — padrões comportamentais
│   └── skills/          — skills promovidas
├── commands/            — autoresearch commands
├── docs/                — specs e planos
├── memory/              — memória de trabalho
│   ├── projects/        — snapshots por projeto
│   ├── decisions.md     — decisões cross-project
│   └── feedback_*.md    — correções e preferências

EXTERNAL (instalado separadamente, gitignored):
├── skills/              — marketplace + gstack (reinstalável)
├── plugins/             — auto-synced pelo Claude Code
└── bin/                 — CLI wrappers (machine-specific)
```

## O que NÃO vai pro git

- `skills/` — marketplace-managed (gstack + Anthropic), reinstalável
- `plugins/` — auto-synced pelo Claude Code
- `bin/` — CLI wrappers machine-specific
- `config.json` — paths locais, incluindo `graphifyBrainPath` quando o default nao for usado
- `settings.local.json` — overrides locais
- `session-env/`, `sessions/`, `session-data/` — dados de sessão
- `debug/`, `cache/`, `file-history/`, `shell-snapshots/` — efêmeros
- `backups/` — **não é cache.** É onde os bootstraps parqueiam arquivo seu que
  foi deslocado por um link gerenciado, com o inode intacto. Fica fora do git
  por ser conteúdo local, não por ser descartável — nada poda esses slots, e
  limpar às cegas apaga o original que o park existia pra preservar
- `.credentials.json` — credenciais OAuth

Lista completa e comentada: §7 de [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
