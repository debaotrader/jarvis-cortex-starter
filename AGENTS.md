**Boot silencioso obrigatório.** NUNCA anuncie status de inicialização ("Cortex carregado", "Lendo X", "RTK.md não existe"). Responda direto à primeira mensagem.

@JARVIS.md

@RTK-codex.md

## Adendos Codex CLI

### Root do cortex
Encontre o root nesta ordem:
1. `$JARVIS_CORTEX_ROOT`, quando setado e contém `JARVIS.md` e `BOOT.md` — override explícito pra checkout fora do path padrão (Windows, CI, clone alternativo). Mesma convenção que `active/rules/enforce-codex.js` e os hooks de `strategic-compact` já honram.
2. Diretório deste `AGENTS.md`, se contém `JARVIS.md` e `BOOT.md`
3. `~/.codex/jarvis-cortex`

### Skills externas esperadas
- Codex local: `~/.codex/skills/`
- gstack: runtime em `~/.codex/skills/gstack/`; source em `~/.gstack/repos/gstack/`
- Plugins Codex: `~/.codex/plugins/cache/`
- pxpipe (opcional, Claude-only): `pxpipe` CLI via `pxpipe-proxy`; usar `scripts/pxpipe.sh start` + `scripts/pxpipe.sh claude` ou `claude-app-on`; `scripts/pxpipe.sh stats` mede a economia real; Codex roda sem pxpipe; allowlist padrao: `claude-fable-5`

### Skills caveman (vendoradas no cortex; sem manifesto de versão — último sync registrado: commit `5f6f73c`)
- `codex/agent-skills/{cavecrew,caveman,caveman-commit,caveman-compress,caveman-help,caveman-review,caveman-stats}`
- Linkadas em `~/.codex/skills/` pelo `scripts/bootstrap-codex.sh`

### Skills promovidas do cortex
- `active/skills/dead-code-audit/SKILL.md` — auditoria de código morto + plano de refatoração
- `active/skills/impeccable/SKILL.md` — design fluency para frontend; symlink em `~/.codex/skills/impeccable` e `~/.agents/skills/impeccable`
- `active/skills/loop-hermes/SKILL.md` — orchestration com subagents + review gate `APPROVED_CLEAN`
- `active/skills/orchestrate/SKILL.md` — pipeline multi-agente
- `active/skills/security-audit/SKILL.md` — auditoria de segurança
- `active/skills/strategic-compact/SKILL.md` — compactação estratégica
- `active/skills/verification-loop/SKILL.md` — loop de verificação e QA
- `active/skills/jarvis-learn/SKILL.md` — aprendizado de correções; renomeado de `learn` pra não colidir com o `learn` do gstack/Codex. Carregar por path ou via skill `jarvis-learn` se symlinkado em `~/.codex/skills/`.

### Skills mattpocock (externas, MIT)
- categorias ativas (engineering/productivity/misc) menos `caveman`, instaladas em `~/.codex/skills/` por `scripts/install-mattpocock-skills.sh` (best-effort, não-fatal). `deprecated`/`in-progress`/`personal` nunca entram
- **Sem lista estática aqui.** O upstream (`$MATTPOCOCK_REPO`, default `https://github.com/mattpocock/skills.git`) não é pinado e renomeia skill — enumerar aqui apodrece. Pra saber o que existe agora, liste o clone. O cache é derivado do diretório-alvo (`dirname` do target), então no Codex é `~/.codex/.cache/mattpocock-skills` e no Claude é `~/.claude/.cache/mattpocock-skills`; `$MATTPOCOCK_CACHE` sobrescreve: `ls "${MATTPOCOCK_CACHE:-$HOME/.codex/.cache/mattpocock-skills}"/skills/{engineering,productivity,misc}`
- `active/contexts/mattpocock-skills.md` guarda o routing, mas **está desatualizado**: roteia por `diagnose`, `to-issues`, `to-prd`, `zoom-out` e `write-a-skill`, nenhum deles presente nas categorias ativas do clone hoje. Não roteie por nome tirado dele sem conferir no clone
- Carregar contexto quando user mencionar TDD/triage/spec/prototype/grilling ou ambiguidade entre `investigate` e a skill de debug do mattpocock
- `caveman` skipped (colide com as skills caveman vendoradas em `codex/agent-skills/`)

### Skill loop-hermes
- `~/.codex/skills/loop-hermes/SKILL.md` — symlink para `active/skills/loop-hermes/SKILL.md`
- Distinto de qualquer skill `loop` built-in (interval runner)

### Setup em máquina nova
- Clone este repo em `~/.codex/jarvis-cortex`
- Rode `~/.codex/jarvis-cortex/scripts/bootstrap-codex.sh` (valida o hook automatico do RTK e cria symlinks: `AGENTS.md`, `RTK.md -> RTK-codex.md`, `hooks.json`, scripts, skills promovidas do cortex e 7 skills caveman)
- **Park-always:** nada pré-existente é apagado. A única remoção é o unlink de um symlink provado ser alias físico do mesmo source; nome que colide com um alvo gerenciado é PARQUEADO — movido pra um slot reservado em `~/.codex/backups/` com o inode intacto — nunca deletado.
- **Gate de topologia antes da primeira mutação:** todo destino gerenciado é resolvido pelo ancestral existente mais profundo e recusado se cair dentro do checkout do cortex. Componente `..` é rejeitado, não normalizado, e checkout com newline no path é recusado. Um `~/.codex` que CONTÉM o checkout é layout documentado e continua suportado — a contenção reversa vale só pros destinos concretos. `$CODEX_HOME/config.toml` é recusado se for symlink, não for arquivo regular, ou tiver link count diferente de 1.
- **Delegação sem herança:** o bootstrap chama `scripts/install-codex-skills.sh` passando todos os destinos explicitamente (`CODEX_HOME`, `GSTACK_BACKUP_DIR`, `AGENTS_TARGET_SKILLS`, `GSTACK_MIGRATED_DIR`, mais `GSTACK_REPO` fixo e os três state roots do gstack), então nada entra pelo ambiente. Invocado **direto**, o `install-codex-skills.sh` continua honrando essas variáveis — escotilha de fork, deliberada.
- Para atualizar o plugin Karpathy depois: `~/.codex/jarvis-cortex/scripts/update-karpathy-skills.sh`

### Segurança
- **Nunca commitar**: `~/.codex/config.toml`, `auth.json`, tokens, `.env`, bancos SQLite, logs ou caches.
- Configs com segredos devem ser recriadas localmente no Mac.

<!-- JARVIS_HANDOFF_START -->

## Handoff para o Jarvis

Quando o usuário disser “gere o handoff para o Jarvis”, encerre a atividade atual produzindo um registro factual da sessão.

Antes de escrever:
- detecte o repositório e a branch atuais;
- inspecione git status e git diff;
- confira os comandos e testes realmente executados;
- não invente resultado ausente;
- não exponha tokens, senhas, chaves, cookies ou credenciais.

Crie:

~/Documents/Jarvis-Handoffs/YYYY-MM-DD-HHMM-<projeto>-<slug>.md

O documento deve conter:

# Handoff Codex → Jarvis

## Contexto
- Projeto:
- Repositório:
- Branch:
- Objetivo da sessão:

## Entregue
- Mudanças realmente concluídas.

## Arquivos alterados
- Caminho e finalidade de cada arquivo relevante.

## Decisões
- Decisão, motivo e alternativas descartadas.

## Verificação
- Comandos e testes executados.
- Resultado real de cada um.
- O que não foi verificado.

## Problemas e riscos
- Bugs encontrados, dívida técnica, riscos e limitações.

## Pendências
- O que ainda falta.
- Próximo passo único recomendado.

## Candidatos a aprendizado
- Convenções estáveis do projeto.
- Erros que podem se repetir.
- Procedimentos que podem virar documentação ou skill.

Regras:
- Seja conciso e factual.
- Diferencie concluído, parcial e não iniciado.
- Não inclua diff completo nem logs enormes.
- Substitua qualquer informação sensível por [REDACTED].
- Não faça commit, push, deploy ou alteração adicional durante o handoff.
- Ao terminar, mostre o caminho absoluto do arquivo criado.

<!-- JARVIS_HANDOFF_END -->
