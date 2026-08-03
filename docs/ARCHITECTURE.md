# Arquitetura do jarvis-cortex

Cortex versionado de identidade, memória, regras, hooks e skills que serve
quatro runtimes: **Claude Code**, **Codex CLI**, **Cursor IDE** e
**OpenCode**. Este doc explica como o sistema se organiza. Detalhes
canônicos de boot vivem em `BOOT.md` — aqui só o mapa.

## 1. Camadas de memória

Hierarquia fixa (ver `BOOT.md` § Hierarquia de Memória):

```
Camada 1 — memória automática do runtime
  └── Claude Code: claude-mem via PostToolUse hook (SQLite, MCP)
  └── Codex CLI:   logs/memórias do runtime quando disponíveis

Camada 2 — memory/  (curadoria manual)
  ├── feedback_*.md   — correções e preferências do dono
  ├── decisions.md    — stack choices cross-project
  └── projects/*.md   — snapshot por projeto (frontmatter: name, type)

Camada 3 — napkin.md  (runbook operacional)
  └── Padrões recorrentes, max 10 por categoria, data + "Do instead"

Camada 4 — active/  (comportamento)
  ├── rules/         — inviolaveis.md, padrao.md, enforce.js, enforce-codex.js
  ├── contexts/      — modos (dev, review, mattpocock-skills)
  ├── instincts/     — padrões YAML em inherited/ (jarvis-seed-instincts.yaml)
  │                    e personal/ (fixar-versao-mcp.yaml)
  ├── skills/        — skills promovidas do cortex
  ├── claude-skills/ — variante Claude Code de impeccable
  └── claude-agents/ — subagents Claude Code do cortex

Camada 5 — Jarvis Brain  (conhecimento duravel)
  └── Markdown privado em JARVIS_BRAIN_HOME
      └── Acesso pelo MCP oficial graphify-brain
```

**Regra prática:** `memory/` e `napkin` guardam curadoria pequena do Cortex.
Conhecimento duravel e decisoes cross-project vao para o Jarvis Brain. Codigo e
runtime atuais continuam sendo a fonte de verdade operacional.

## 2. Fluxo de boot

Referência canônica: [`BOOT.md`](../BOOT.md). Sequência silenciosa
(nenhum "Cortex carregado" deve aparecer):

1. **Identidade** — no Claude Code e no Codex o wrapper (`CLAUDE.md` /
   `AGENTS.md`) importa `JARVIS.md` + o RTK do runtime e aponta pra
   `active/rules/inviolaveis.md` + `active/rules/padrao.md`.
   **No Cursor é indireto:** `cursor/rules/jarvis-cortex.mdc` (`alwaysApply`)
   não importa `JARVIS.md` nem arquivo de RTK — traz identidade resumida
   inline, uma regra de RTK escrita à mão e um ponteiro pro `BOOT.md`. O
   hook `sessionStart` complementa injetando o texto de `inviolaveis.md`
   mais ponteiros pro `BOOT.md` e pro `padrao.md`.
2. **Memória** — `MEMORY.md` (índice) e `napkin.md` (runbook).
3. **Contexto do projeto** — se há `memory/projects/<projeto>.md` ativo.
4. **Módulos sob demanda** — `active/contexts/`, `active/skills/` por skill
   routing do `JARVIS.md`.
5. **Jarvis Brain** — sob demanda, via MCP `graphify-brain`.

**Antes da compactação:** o hook `pre-compact.js` grava um snapshot de
auditoria e emite a instrução em `systemMessage` **pedindo** ao modelo que
salve Lições/Decisões/Pendências. É prompt, não garantia — o hook não persiste
nada sozinho. `systemMessage` e não `hookSpecificOutput`: o schema do
PreCompact só aceita `hookSpecificOutput` em PreToolUse/UserPromptSubmit/
PostToolUse/PostToolBatch/Stop, então emitir ali reprovava na validação e
descartava a instrução inteira. Reinício usa o mesmo fluxo silencioso.

## 3. Quem usa o quê

| Runtime | Config raiz | Como chega | O que lê |
|---|---|---|---|
| **Claude Code** | `~/.claude/*` | symlinks criados por `scripts/bootstrap-claude.sh` | `CLAUDE.md`, `JARVIS.md`, `RTK.md`, `MEMORY.md`, `active/`, `memory/`, `settings.json`, `scripts/`, skills promovidas em `~/.claude/skills/` |
| **Codex CLI** | `~/.codex/*` | symlinks criados por `scripts/bootstrap-codex.sh` | `AGENTS.md`, `JARVIS.md` (via AGENTS), `RTK-codex.md` (linkado como `RTK.md`), `codex/hooks.json`, skills vendored em `~/.codex/skills/`, skills promovidas via `~/.codex/skills/<name>` |
| **Cursor IDE** | `~/.cursor/*` (honra `CURSOR_HOME`) | symlinks + merge JSON por `scripts/bootstrap-cursor.sh` | `rules/jarvis-cortex.mdc` (`alwaysApply`), `cursor/hooks/*.js` linkados em `~/.cursor/hooks/`, entradas jarvis-managed mescladas em `hooks.json` e `mcp.json`, `permissions.json` linkado, skills nativas curadas em `~/.cursor/skills` |
| **OpenCode** | `~/.config/opencode/opencode.jsonc` | **paths absolutos** (não symlink) | `BOOT.md`, `JARVIS.md`, `CLAUDE.md`, `RTK-codex.md`, `active/rules/inviolaveis.md`, `active/rules/padrao.md` + paths de skills + MCPs |

**Diferença crítica:** Claude, Codex e Cursor usam symlinks (path indirection)
— o Cursor ainda mescla blocos jarvis-managed dentro dos JSON dele em vez de
substituir o arquivo. OpenCode grava paths absolutos direto pra este repo, o
que quebra quando o repo muda de lugar.

**Park-always.** Nenhum bootstrap apaga arquivo pré-existente. O `link_file`
compartilhado por `bootstrap-claude.sh`, `bootstrap-codex.sh` e
`bootstrap-cursor.sh` tem exatamente três desfechos pro que já ocupa um alvo:
symlink já escrito exatamente como o nosso source e resolvendo → intocado
(caminho idempotente do re-run); symlink **provado** ser alias físico do mesmo
source → unlink, a única remoção do arquivo e exceção aprovada pelo dono;
qualquer outra coisa → PARQUEADA, movida pra um slot reservado em
`backups/` sob o home do harness (`$CLAUDE_HOME`, `$CODEX_HOME`,
`$CURSOR_HOME`) com o inode intacto, e o link novo toma o lugar. Nenhuma
comparação de conteúdo decide remoção, então não há comparação pra errar.
`install-codex-skills.sh` segue a mesma política e não tem nem o unlink de
alias — **escopo preciso:** a garantia vale nas operações dele sobre alvos e
staging, e **não** cobre trabalho delegado a outro programa (`git pull
--ff-only` num checkout gstack preexistente remove arquivo apagado upstream, e
o `./setup` do gstack faz o que o upstream decidir). Esses são outras
ferramentas agindo nas árvores delas. Consequência declarada e aceita: cada
park cria um slot novo, com
timestamp, e **nada poda** esses slots — eles acumulam até você limpar à mão
(ver §7: `backups/` não é cache).

**Gate de topologia.** Antes da primeira mutação, `bootstrap-codex.sh` e
`bootstrap-cursor.sh` resolvem cada destino gerenciado — `MANAGED_TREES`
(diretórios) e `MANAGED_LEAVES` (alvos de link individuais) — pelo ancestral
existente mais profundo, e recusam se o resultado cair dentro do checkout do
cortex. Componente `..` é REJEITADO, não normalizado, e um checkout cujo path
contenha newline é recusado antes de qualquer mutação. A contenção reversa (o
destino contém o checkout) vale pros **destinos concretos**, não pro home
gerenciado: `~/.codex/jarvis-cortex` é root de cortex documentado, então um
home que legitimamente contém o checkout é suportado. Onde uma checagem recusa
o que a doc manda fazer, a checagem é que está errada.

**Delegação sem herança de ambiente.** `bootstrap-codex.sh` chama
`install-codex-skills.sh` passando **todos** os destinos explicitamente —
`CODEX_HOME`, `GSTACK_BACKUP_DIR`, `AGENTS_TARGET_SKILLS`,
`GSTACK_MIGRATED_DIR`, mais `GSTACK_REPO` como constante e os três state roots
do gstack (`GSTACK_STATE_ROOT`, `GSTACK_HOME`, `GSTACK_STATE_DIR`). É isso que
torna o gate de topologia vinculante: os valores gateados são exatamente os
que o delegado recebe, então nada entra pelo ambiente. O
`install-codex-skills.sh` continua honrando essas variáveis quando invocado
**direto** — essa é a escotilha de fork, deliberada.

⚠️ **`bootstrap-opencode.sh` cria ou recusa — nunca reescreve.** Três
desfechos, só três: config ausente → escreve um novo e completo; config
existente cujo bloco entre `// >>> jarvis-managed (regenerated by
bootstrap-opencode.sh)` e `// <<< jarvis-managed` já é byte-a-byte o atual →
no-op; **qualquer outra coisa → RECUSA**, não escreve nada e imprime o reparo.
Não existe backup porque não existe reescrita: o arquivo do usuário nunca é
tocado. Reescrever JSONC alheio em bash produziu quatro jeitos distintos de
destruir config do usuário; os dois caminhos que não podem perder dado são
justamente os dois que não reescrevem.

A publicação é um hard link — `command /bin/link` de um stage pro alvo.
`link(2)` falha com `EEXIST` se algo ocupar o alvo, então "só cria se não
existe" é garantido pelo kernel no instante da escrita, e não por um
`[ ! -f ]` alguns milissegundos antes. `ln` foi descartado: no macOS
`ln ORIGEM DIR` significa "linkar DENTRO de DIR" e sai 0 tendo criado
`<alvo>/<nome-do-stage>`.

**Recusas (todas exit 3, nada escrito):** alvo é symlink; alvo não é arquivo
regular; config existente sem o par de markers; markers malformados; bloco
gerenciado desatualizado; bloco atual mas arquivo com bit de grupo/outro
ligado (pede `chmod 600` — o script não faz o chmod sozinho); `/bin/link`
ausente ou não executável; componente `..` no path do alvo (rejeitado, não
normalizado); caractere de controle em `$HOME` ou no path do cortex. Com
`--project`, ainda: diretório dentro do checkout do cortex; dentro de qualquer
work tree git (qualquer `.git` de qualquer tipo no diretório ou em qualquer
ancestral, dangling incluso); qualquer um dos oito `GIT_*` de redirecionamento
setado (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
`GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`); `git` fora do
PATH; ou `git rev-parse` falhando de forma inesperada. Não há julgamento sobre
QUAIS estados de repositório são aceitáveis — duas brechas moravam nessa
interrogação, então ela sumiu.

**Contrato de status — o `install.sh` depende dele:**

| Status | Significado |
|---|---|
| `0` | sucesso (escreveu, ou já estava atualizado) |
| `1` | falha inesperada. **Não** garante que nada foi escrito: com dois alvos a publicação é sequencial e o primeiro pode ter sido criado antes do segundo falhar. A mensagem no stderr é a autoridade sobre quais alvos existem — não infira estado do status |
| `2` | erro de uso (argumento desconhecido) |
| `3` | recusa deliberada. Nada foi escrito: recusa só acontece na fase 1, antes de qualquer publicação |

`install.sh all` reporta `SKIPPED` no 3 e segue; `install.sh opencode` falha
no 3. Qualquer outro status não-zero aborta até no `all`.

**Reparo depois de mover o repo:** o bloco fica velho e o script recusa. O
caminho suportado é apagar o `opencode.jsonc` e rodar de novo, guardando antes
as chaves manuais pra recolar **acima** da linha `// >>> jarvis-managed` —
tudo acima do marker é seu e nunca é comparado. Config velho é o defeito
benigno original; config destruído não é.

Resíduo declarado e aceito: um Ctrl-C ou SIGKILL pode deixar um
`.opencode-jarvis-stage.XXXXXX` no diretório do config. É inofensivo — o
opencode só lê `opencode.jsonc`. Contrato completo e limitações medidas:
cabeçalho de `scripts/bootstrap-opencode.sh`.

## 4. Onde adicionar nova skill

```
A skill é:
  │
  ├─ Promovida pelo cortex (workflow world-class do dono)?
  │    └─ → active/skills/<name>/SKILL.md
  │        Instalada em ~/.claude/skills/, ~/.codex/skills/ e ~/.cursor/skills
  │        via bootstrap. Exceção: impeccable tem duas variantes versionadas —
  │        active/claude-skills/impeccable (Claude Code) e
  │        active/skills/impeccable (Codex e Cursor).
  │
  ├─ Snapshot vendorado no repo (conjunto heterogêneo — liste o diretório)?
  │    └─ → codex/skills-local/<name>/
  │        Fonte versionada, NÃO regenerada: install-codex-skills.sh copia
  │        cada subdiretório pra ~/.codex/skills, pulando .system, gstack,
  │        codex-primary-runtime, napkin e todo nome já promovido em
  │        active/skills. Não remove nada: árvore já idêntica fica intocada,
  │        e qualquer outra coisa ocupando o caminho é PARQUEADA num slot de
  │        backup antes da cópia entrar. As hm-* daí também chegam ao Claude
  │        Code (bootstrap-claude.sh) e ao Cursor (catálogo nativo). O
  │        opencode aponta pro diretório direto.
  │
  ├─ Skill caveman?
  │    └─ → codex/agent-skills/<name>/  (7 skills)
  │        Symlinkada em ~/.codex/skills/ por bootstrap-codex.sh e no
  │        Cursor pelo catálogo nativo. NÃO fica em skills-local.
  │
  ├─ Precisa aparecer no Cursor?
  │    └─ → não existe pasta separada: o Cursor monta uma árvore nativa
  │        curada a partir de scripts/cursor-skill-catalog.mjs
  │        (skills promovidas, impeccable, jarvis-cortex, hm-*, caveman) e
  │        das skills gstack. scripts/cursor-skill-manifest.mjs valida e emite
  │        o manifesto; bootstrap-cursor.sh reconcilia ~/.cursor/skills contra
  │        ele (link, cursor-copy ou gstack-copy conforme a origem).
  │        Skill nova só aparece no Cursor depois de entrar no catálogo.
  │
  ├─ Específica de plugin (figma, documents, presentations)?
  │    └─ → plugins/cache/<plugin>/skills/  (auto-synced, não versionar)
  │
  └─ Clone externo, fora do repo?
       ├─ mattpocock → clonado por install-mattpocock-skills.sh num cache
       │   fora do dir de skills e symlinkado em ~/.claude/skills/ ou
       │   ~/.codex/skills/. Upstream não pinado.
       ├─ gstack (repo completo) → clonado por install-codex-skills.sh em
       │   ~/.gstack/repos/gstack; é dele que o Cursor tira as gstack-copy.
       └─ marketplace → ~/.claude/skills/<name>/ ou ~/.codex/skills/<name>/
           Nenhum desses vai pro git. Reinstalar pelo instalador/marketplace.
```

**Quando promover uma skill para `active/skills/`** (não vale a pena pra
tarefa única, vale pra recurring com checklist estável):

1. Criar `active/skills/<kebab-name>/SKILL.md` com frontmatter
   `name`, `description`, opcional `version`.
2. Cada harness tem a própria lista de skills promovidas, e o nome precisa
   entrar nas **três** — nenhuma delas vive no `bootstrap-codex.sh`. Procure
   a lista (grep pelo nome de uma skill já promovida) em:
   - Claude Code: `scripts/bootstrap-claude.sh`
   - Codex: `scripts/install-codex-skills.sh`
   - Cursor: `scripts/cursor-skill-catalog.mjs`
3. Commitar e rodar `bash scripts/bootstrap-claude.sh` pra symlinkar.
   `scripts/install.sh all` cobre os outros harnesses, mas só os que a
   máquina tem dependência pra rodar — veja os skips em §6.
4. Smoke test descobre via `tests/smoke.test.js`.

## 5. Hooks em runtime

Hooks Node em `active/rules/`, `active/skills/strategic-compact/`,
`scripts/` e `cursor/hooks/`, mais o binário externo `rtk`. Registro por
runtime: `settings.json` (Claude Code), `codex/hooks.json` (Codex),
`cursor/hooks.json` (Cursor).

| Hook | Runtime (registro) | Evento / matcher | O que faz |
|---|---|---|---|
| `rtk hook claude` (binário RTK) | Claude Code (`settings.json`) | PreToolUse `Bash` | Reescreve o comando pro equivalente `rtk`. Obrigatório, nunca desabilitar |
| `active/rules/enforce.js` | Claude Code (`settings.json`) | PreToolUse `Edit\|Write\|Bash` | Soft-block em `.env`, `ecosystem.config`, `nginx`, `pm2.config` + comandos perigosos (pm2 lifecycle, git push --force, rm -rf em root/home, SQL DROP) |
| `active/skills/strategic-compact/suggest-compact.js` | Claude Code (`settings.json`) | PreToolUse `Edit\|Write` | Sugere `/compact` estratégico após N tool calls (default 50) |
| `active/skills/strategic-compact/pre-compact.js` | Claude Code (`settings.json`) | PreCompact `*` | Grava snapshot de auditoria e injeta instrução pedindo ao modelo que salve Lições/Decisões/Pendências. Não persiste por conta própria |
| `active/skills/strategic-compact/session-start.js` | Claude Code (`settings.json`) | SessionStart `compact` | Reinjeta `inviolaveis.md` como `additionalContext` depois da compactação |
| `active/rules/enforce-codex.js` | Codex (`codex/hooks.json`) | PreToolUse `Bash\|Edit\|Write` | Mesma lógica de proteção pro Codex |
| `scripts/rtk-codex-hook.js` | Codex (`codex/hooks.json`, linkado em `~/.codex/scripts/`) | PreToolUse `Bash` | Adaptador RTK do Codex |
| `cursor/hooks/rtk-shell.js` | Cursor (`cursor/hooks.json`) | preToolUse `Shell` | Traduz o payload de shell do Cursor pro formato que `rtk hook claude` entende e devolve o rewrite |
| `cursor/hooks/enforce-cursor.js` | Cursor (`cursor/hooks.json`) | preToolUse `Write\|Edit\|StrReplace\|Delete\|EditNotebook`, `beforeShellExecution`, `beforeMCPExecution` | Adaptador do `enforce.js` pro Cursor (fail-closed: todo caminho de decisão emite JSON allow/deny e sai 0) |
| `cursor/hooks/session-start.js` | Cursor (`cursor/hooks.json`) | sessionStart | Reancora regras invioláveis e aponta o `BOOT.md` do cortex |

**Fail-closed, por runtime.** Payload que o guard não consegue avaliar bloqueia
em vez de liberar, mas o formato do bloqueio difere. `enforce.js`: JSON
malformado, top-level não-objeto ou `tool_name` ausente/vazio/só-invisível →
exit 2. `enforce-codex.js`: JSON malformado ou top-level não-objeto → exit 2;
ele não tem gate por `tool_name` — extrai paths e comandos do payload
independentemente do nome da ferramenta. `enforce-cursor.js` não usa status:
todo caminho de decisão emite JSON `allow`/`deny` e sai 0, e nome de ferramenta
ausente ou não mapeado sai como `deny` (medido: `echo '{}' | node
cursor/hooks/enforce-cursor.js` → exit 0 + `"permission":"deny"`). Ele delega a
inspeção de comando ao `enforce.js`, então espelha aquela coluna. Stdin vazio é
o caso legítimo "nenhuma tool call ainda" e libera silencioso nos três. Nome de ferramenta, chave de payload, nome de container,
nome de evento e basename de executável casam **case-insensitive**.

**Log dos guards.** `enforce.js` e `enforce-codex.js` gravam num `debug/`
sob o dir do runtime (ambos honram `JARVIS_CORTEX_ROOT`; nenhum lê
`CODEX_HOME`). Nenhum campo da linha é controlado pelo caller: path, comando e
nome de ferramenta entram só como SHA-256 truncado em 12 hex, a categoria da
ferramenta vem de uma lista fixa, e o `reason=` sai de vocabulário CONSTANTE
(`rule.label` + `rule.id`, ou uma chave da allowlist de `git -c`) — nunca
construído a partir do texto casado. Um registro é exatamente uma linha:
controles Unicode são colapsados, então não dá pra forjar fronteira de
registro. Formato exato e destino: leia o guard correspondente.

**Teto dos guards (decisão, não lacuna).** `enforce.js` e `enforce-codex.js`
são **gate de casamento de token, não parser de shell**. Normalizam whitespace
e Unicode, quebram o comando em tokens e comparam contra vocabulário fixo — sem
modelo de gramática, sem expansão, sem noção de posição de comando ou de onde
um comando termina e o próximo começa. Existem pra pegar invocação
**descuidada ou acidental**, não adversário que escolhe os bytes exatos do
comando. Quatro classes ficam abertas **por decisão**: substituição de comando
(`$( )` e crases), operador colado sem espaço, forma de executável que não é o
basename, e nome de arquivo que o shell compõe de pedaços. Medido nos três
runtimes, `echo x$(Git --git-dir=/r push --force origin main)`,
`true;Git --git-dir=/r push --force origin main` e `printf x > .e''nv` passam
livres em **todos**. A cobertura NÃO é simétrica e a assimetria é sorte, não
design: o `enforce.js` tem uma segunda camada de regex `/i` (`DANGEROUS_COMMANDS`)
que o `enforce-codex.js` não tem, então spellings como `true;rm -rf /` e
`./tools-git push --force` são pegos no lado Claude/Cursor e ficam abertos só no
Codex — `\bgit` casa dentro de `tools-git` por acidente, e renomear o binário
pra `toolsgit` abre lá também. Seis rodadas de hardening do tokenizer acharam
uma evasão nova dessa mesma classe cada uma, e já cobravam preço em trabalho
comum (`env=development node app.js` interrompia o usuário). A camada que contém
adversário determinado é o sistema de permissão acima do hook, não o hook. O
bloco `CEILING` no topo de cada guard tem a tabela por runtime; não reescreva
uma afirmação de lá sem re-rodar nos três.

## 6. Setup em máquina nova

Caminho padrão — `scripts/install.sh` é o entrypoint unificado: roda o
bootstrap do(s) harness(es) pedido(s) e depois o `doctor.sh`. O doctor roda em
**todos** os modos, não só no `all`, e o exit code dele é o exit code do
`install.sh`.

```bash
git clone https://github.com/debaotrader/jarvis-cortex-starter.git ~/.codex/jarvis-cortex
~/.codex/jarvis-cortex/scripts/install.sh        # claude + opencode + cursor + codex
~/.codex/jarvis-cortex/scripts/doctor.sh         # exit 0 = healthy
rtk --version && rtk gain
```

**`all` não garante instalação completa.** No modo `all` o `install.sh` pula
harness inteiro em **três** situações, anunciando o skip e seguindo:

- falta `node` no PATH → pula o Cursor;
- falta o CLI `codex` no PATH → pula o Codex;
- `bootstrap-opencode.sh` sai **3** (recusa deliberada, nada escrito) → pula o
  opencode. Essa é a única que não dá pra sondar antes: só o bootstrap sabe se
  o config carrega o par de markers, então ele roda e a razão já está na tela
  quando o skip é decidido.

Qualquer outro status não-zero é falha inesperada e aborta até no `all`. Além
disso vários substeps (gstack, karpathy, mattpocock, Graphify Brain) são
opcionais e podem avisar e continuar — enquanto outros são fatais (`bun`
ausente com linha gstack no manifesto faz o `bootstrap-cursor.sh` sair 1). A
lista exata muda: leia `scripts/install.sh` e os bootstraps que ele chama.

Instale `node` e o CLI `codex` antes de rodar `install.sh all`, ou rode
`install.sh cursor` / `install.sh codex` depois — no modo explícito o
bootstrap falha alto em vez de pular, e `install.sh opencode` falha também no
exit 3. Em qualquer caso leia o `doctor.sh`, que roda por último em todo modo
e cujo exit code o `install.sh` propaga.

`install.sh [claude|codex|opencode|cursor|all]` limita a um harness. Os
bootstraps continuam chamáveis direto quando você quer só um pedaço:

```bash
~/.codex/jarvis-cortex/scripts/bootstrap-claude.sh     # Claude Code
~/.codex/jarvis-cortex/scripts/bootstrap-codex.sh      # Codex CLI (precisa do CLI `codex`)
~/.codex/jarvis-cortex/scripts/bootstrap-cursor.sh     # Cursor IDE (precisa de node; e de bun se o manifesto tiver linha gstack — senão sai 1)
~/.codex/jarvis-cortex/scripts/bootstrap-opencode.sh   # OpenCode (--project gera <cwd>/opencode.jsonc)
```

```bash
# Brain privado + MCP oficial
git clone https://github.com/YOUR-USER/jarvis-brain.git ~/.jarvis/brain
~/.codex/jarvis-cortex/scripts/setup-graphify-brain.sh --all
```

Detalhes completos em [`SETUP.md`](../SETUP.md).

## 7. O que NÃO vai pro git

Ver `.gitignore` — é a fonte de verdade. Resumo do que está lá hoje:

- `.credentials.json`, `.update.lock`, `mcp-needs-auth-cache.json`,
  `settings.local.json`, `config.json`, `.env` / `.env.*` (exceto
  `.env.example|sample|template`) — credenciais e paths locais
- `history.jsonl`, `sessions/`, `/projects/`, `session-data/`,
  `session-env/` — logs de conversa e dados de sessão
- `paste-cache/`, `cache/`, `__pycache__/`, `*.py[cod]`, `debug/`,
  `file-history/`, `shell-snapshots/`, `tasks/`, `teams/`, `/plans/`,
  `telemetry/`, `ide/*.lock` — caches e efêmeros
- `backups/` — **não é cache.** É onde os bootstraps preservam arquivo do
  usuário que foi deslocado por symlink (`CLAUDE_BACKUP_DIR`,
  `GSTACK_BACKUP_DIR`). Fica fora do git por conter conteúdo local, não por
  ser descartável — não limpe às cegas
- `/skills/` e `plugins/` — marketplaces auto-reinstaláveis (`active/skills/`
  fica versionado de propósito)
- `.claude/`, `bin/` — internals do runtime e wrappers de CLI por máquina
- `memory/sessions/`, `*.original.md` — memória transiente e backups pós-refactor
- `.DS_Store`, `**/.DS_Store` — macOS Finder metadata

Não há hoje padrão global pra `*.log` nem pra `graphify-out/.graphify_*`; o
que cobre log é o diretório `debug/`.
