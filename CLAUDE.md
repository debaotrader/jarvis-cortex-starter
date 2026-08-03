**Boot silencioso obrigatório.** NUNCA anunciar status init ("Cortex carregado", "Lendo X", "RTK.md não existe"). Responder direto à primeira mensagem.

@JARVIS.md

@RTK.md

## Adendos Claude Code

### Root do cortex
Achar root nesta ordem:
1. Diretório deste `CLAUDE.md`, se contém `JARVIS.md` e `BOOT.md`
2. `~/.claude`, quando arquivos são symlinks pro cortex
3. `~/.codex/jarvis-cortex`

### Runtime
- Memória automática: `claude-mem` plugin (SQLite via PostToolUse hooks). Não duplicar em `memory/` o que ele já grava.
- Skill routing: invocar via **Skill tool** como primeira ação, obedecer precedência em `JARVIS.md`.
- RTK obrigatório via `@RTK.md` e hook `rtk hook claude`. Hook falhou: usar `rtk` direto, reportar lacuna sem ruído de boot.
- Hooks ativos: ver `~/.claude/settings.json` (RTK PreToolUse Bash + enforce.js + strategic-compact + caveman SessionStart/UserPromptSubmit/statusLine).
- Plugin caveman: `~/.claude/plugins/cache/caveman/...` (v1.8.1, instalado via marketplace `JuliusBrussee/caveman`).

### Skills externas esperadas
- Claude local: `~/.claude/skills/`
- gstack: `~/.claude/skills/gstack/`
- Plugins Claude: `~/.claude/plugins/cache/`
- pxpipe (opcional): `pxpipe` CLI via `pxpipe-proxy`; usar `scripts/pxpipe.sh start` + `scripts/pxpipe.sh claude`, ou `scripts/pxpipe.sh claude-app-on` para o Claude.app; medir com `scripts/pxpipe.sh stats`
- HM (Higher Mind): 13 skills vendoradas em `codex/skills-local/hm-*` (`hm-cli`, `hm-data-integrity`, `hm-deploy`, `hm-design`, `hm-designer`, `hm-engineer`, `hm-init`, `hm-llm-guardrails`, `hm-performance`, `hm-qa`, `hm-security`, `hm-ux-flow`, `hm-validate-all`), instaladas em `~/.claude/skills` por `scripts/bootstrap-claude.sh` e em `~/.codex/skills` por `scripts/install-codex-skills.sh`
- Karpathy: `karpathy-guidelines`
- Skills mattpocock: skills das categorias ativas (engineering/productivity/misc) de `github.com/mattpocock/skills` menos `caveman` (~18), instaladas por `scripts/install-mattpocock-skills.sh` em `~/.claude/skills/`. Catálogo + routing em `active/contexts/mattpocock-skills.md` — carregar quando user mencionar TDD/triage/PRD/prototype/grilling/zoom-out ou ambiguidade `investigate` vs `diagnose`.

### Skills promovidas do cortex
- `active/skills/dead-code-audit/SKILL.md` — auditoria código morto + plano refactor
- `active/claude-skills/impeccable/SKILL.md` — design fluency para frontend; symlink em `~/.claude/skills/impeccable`; agente auxiliar em `active/claude-agents/impeccable-manual-edit-applier.md`
- `active/skills/loop-hermes/SKILL.md` — orchestration com subagents + review gate `APPROVED_CLEAN`; no Claude Code, re-review depois de `REQUEST_CHANGES` obrigatório pelo plugin `codex@openai-codex`
- `active/skills/orchestrate/SKILL.md` — pipeline multi-agente
- `active/skills/security-audit/SKILL.md` — auditoria segurança
- `active/skills/strategic-compact/SKILL.md` — compactação estratégica
- `active/skills/verification-loop/SKILL.md` — loop verificação + QA
- `active/skills/jarvis-learn/SKILL.md` — aprendizado de correções; discoverable como skill `jarvis-learn` (symlink em `~/.claude/skills/jarvis-learn`). Renomeado de `learn` porque o gstack ocupa esse nome. Use `learn` do gstack só pra show/prune/export de learnings; use `jarvis-learn` pro loop de correção do cortex.

### Skill loop-hermes
- Skill `loop-hermes` em `~/.claude/skills/loop-hermes/`: symlink pra `active/skills/loop-hermes/`. Distinto do built-in `loop` (interval runner). Re-review depois de `REQUEST_CHANGES` feito pelo plugin `codex@openai-codex`; plugin indisponível: parar em `NEEDS_DECISION`.

### Setup em máquina nova
- Clonar este repo em `~/.codex/jarvis-cortex` ou outro path local estável
- Rodar `scripts/bootstrap-claude.sh` do root do cortex (cria symlinks em `~/.claude`: `CLAUDE.md`, `JARVIS.md`, `RTK.md`, `BOOT.md`, `active/`, `memory/`, `settings.json`, `scripts/` e skills promovidas sem tocar secrets)
- Pro Codex, rodar também `scripts/bootstrap-codex.sh`

### Segurança
- **Nunca commitar**: `~/.claude/settings.local.json`, `.credentials.json`, tokens, `.env`, bancos SQLite, logs, sessões ou caches.
- Configs com segredos: recriar localmente no Mac.
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.
