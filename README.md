# jarvis-cortex

The brain of **JARVIS** — personal AI agent configuration shared by [Claude Code](https://claude.ai/code), Codex CLI, Cursor IDE, and opencode.

Identity, memory, rules, hooks, skills, and instincts. Everything that makes JARVIS who he is.

## What's Inside (tracked in git)

```
JARVIS.md            — canonical identity; see §2–3 of docs/ARCHITECTURE.md for
                        per-runtime reach
CLAUDE.md            — Claude Code wrapper (imports JARVIS.md + RTK.md)
AGENTS.md            — Codex CLI wrapper (imports JARVIS.md + RTK-codex.md)
BOOT.md              — initialization sequence (what JARVIS reads first)
RTK.md               — Rust Token Killer contract (Claude Code)
RTK-codex.md         — Rust Token Killer contract (Codex)
MEMORY.md            — index into memory/ (projects, feedback, decisions);
                        does not list every file there
napkin.md            — curated operational runbook
README.md            — this file
SETUP.md             — full setup walkthrough
settings.json        — hooks, MCP servers, Claude Code config. TRACKED AND LIVE:
                        bootstrap-claude.sh symlinks ~/.claude/settings.json to
                        it, so a running Claude Code session writes its own state
                        straight into this file (model, tui, and other settings
                        have changed under an editing session). It dirties the
                        checkout silently — ALWAYS read `git diff settings.json`
                        before committing, or you will ship machine-local drift
settings.json.example — annotated JSONC copy of settings.json (_comment/_README
                        fields). STALE: its header claims settings.json is
                        gitignored and tells you to `cp` over it — neither is
                        true here, settings.json is tracked. It also still
                        carries a permissions.allow entry the live file dropped
config.json.example  — template for config.json, which IS gitignored
package.json         — test runner wiring (`npm test` → tests/run-all.js)
.gitignore           — ignore patterns (does not affect already-tracked files)
.gitattributes       — path attributes

active/              — modules loaded on demand
  rules/             — inviolable rules + enforce.js / enforce-codex.js
  contexts/          — switchable modes (dev, review, mattpocock-skills)
  instincts/         — behavioral patterns (inherited + personal)
  skills/            — promoted skills (strategic-compact, etc.)
  claude-skills/     — Claude Code variant of impeccable
  claude-agents/     — Claude Code subagents

codex/               — Codex assets (hooks.json, agent-skills/, skills-local/, skill-source/)
cursor/              — Cursor assets (hooks.json, hooks/, rules/, mcp.json, permissions.json)
scripts/             — install.sh, doctor.sh, per-harness bootstraps, cursor-* helpers
tests/               — smoke + correctness tests (run-all.js)
commands/            — autoresearch slash commands
docs/                — ARCHITECTURE.md + design specs and plans (historical)
memory/              — curated memory (projects, decisions, feedback)
.github/             — CI workflow
```

## Memory Architecture

Five-layer hierarchy (claude-mem SQLite → `memory/` → `napkin.md` → `active/` → private Jarvis Brain).
See [BOOT.md](BOOT.md#hierarquia-de-memoria) for details.

## Dependencies

### External (not tracked, installed separately)

| Dependency | What | Install |
|-----------|------|---------|
| **Graphify** | Native durable Brain graph, CLI, and MCP | `uv tool install --python 3.12 "graphifyy[mcp]==0.9.11"` |
| **gstack** | Skill suite (ship, qa, investigate, browse, etc.). Skill count tracks upstream — check the clone, not this table | Cloned by `scripts/install-codex-skills.sh` from `$GSTACK_REPO` (default `https://github.com/garrytan/gstack.git`) into `~/.gstack/repos/gstack` |
| **mattpocock** | Whatever the `engineering`, `productivity` and `misc` categories hold upstream, minus `caveman` (plugin owns it). Upstream is **not pinned** and renames skills, so no static list here. The only current source of truth is the clone itself, cached next to whichever skills dir was targeted — `~/.claude/.cache/mattpocock-skills` for Claude, `~/.codex/.cache/mattpocock-skills` for Codex, or `$MATTPOCOCK_CACHE`: `ls ~/.claude/.cache/mattpocock-skills/skills/{engineering,productivity,misc}`. `active/contexts/mattpocock-skills.md` is **not** current — it routes on `diagnose`, `to-issues`, `to-prd`, `zoom-out` and `write-a-skill`, none of which exist in the clone's active categories today | `scripts/install-mattpocock-skills.sh` (best-effort, non-fatal; needs git + network) from `$MATTPOCOCK_REPO` (default `https://github.com/mattpocock/skills.git`, MIT) |
| **claude-mem** | Automatic cross-session memory (SQLite, MCP tools) | Claude Code plugin (auto-sync) |
| **Skills** | Anthropic marketplace skills | Auto-sync on Claude Code launch |
| **Plugins** | Claude Code plugins (codex, n8n-to-langgraph, etc.) | Auto-sync on Claude Code launch |

### Internal (vendored in this repo, no external fetch)

opencode is the odd one out: it copies and symlinks nothing. Its generated
config block lists paths (in-repo and external) plus MCP servers — see §3 of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which carries the OpenCode
warning about pre-existing configs.

| Source | What | Reaches |
|--------|------|---------|
| `active/skills/` | Promoted cortex workflows | `~/.claude/skills` (`bootstrap-claude.sh`, but impeccable comes from `active/claude-skills/`), `~/.codex/skills` (`install-codex-skills.sh`), `~/.cursor/skills` (native catalog), and opencode directly as a skills path |
| `codex/skills-local/hm-*` | **Higher Mind** — 13 cortex-owned skills (`hm-init`, `hm-engineer`, `hm-design`, `hm-qa`, `hm-cli`, `hm-data-integrity`, `hm-deploy`, `hm-designer`, `hm-llm-guardrails`, `hm-performance`, `hm-security`, `hm-ux-flow`, `hm-validate-all`) | `~/.claude/skills` (`bootstrap-claude.sh`), `~/.codex/skills` (`install-codex-skills.sh`), `~/.cursor/skills` (native catalog), and opencode via the `codex/skills-local` path. On the Claude side a user's own `hm-<name>` dir is skipped with a warn (non-clobbering); the Codex installer parks it — see the `skills-local` row |
| `codex/skills-local/` (rest) | A heterogeneous set of vendored snapshots — list the directory rather than trusting a description here | `~/.codex/skills` (`install-codex-skills.sh`), and opencode as a skills path. Not wired into Claude or Cursor. Not a wholesale copy: `.system`, `gstack`, `codex-primary-runtime`, `napkin` and every name already promoted under `active/skills/` are skipped, a target that is already byte-identical is left untouched, and anything else occupying a target is **parked** in a reserved backup slot — never deleted |
| `codex/agent-skills/` | caveman, 7 skills. No version manifest in-repo; the last recorded sync is commit `5f6f73c` ("sync caveman skills from plugin 655b7d9c5431") | `~/.codex/skills` (`bootstrap-codex.sh`), `~/.cursor/skills` (native catalog), and opencode as a skills path |
| `codex/skill-source/jarvis-cortex` | The `jarvis-cortex` skill itself | `~/.cursor/skills` (native catalog) |

## Hooks

Registered in `settings.json` for Claude Code (Codex and Cursor register their
own in `codex/hooks.json` and `cursor/hooks.json` — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#5-hooks-em-runtime)):

| Hook | Matcher | File | What it does |
|------|---------|------|--------------|
| **PreToolUse** | `Bash` | `rtk hook claude` (external RTK binary) | Rewrites eligible shell commands to their `rtk` equivalent. Mandatory — never disable |
| **PreToolUse** | `Edit\|Write\|Bash` | `active/rules/enforce.js` | Soft-blocks dangerous operations (.env, pm2, force push, rm -rf) |
| **PreToolUse** | `Edit\|Write` | `active/skills/strategic-compact/suggest-compact.js` | Suggests strategic compaction when context grows |
| **PreCompact** | `*` | `active/skills/strategic-compact/pre-compact.js` | Writes an audit snapshot and injects a prompt asking the model to save lessons/decisions/pending work (inviolable rule #11). It does not extract or persist them itself |
| **SessionStart** | `compact` | `active/skills/strategic-compact/session-start.js` | Re-injects `inviolaveis.md` as additionalContext after compaction |

`enforce.js` and its Codex twin are a **token-matching gate, not a shell parser
and not a security boundary**. They tokenize the command and compare against a
fixed vocabulary; they catch careless and accidental invocations, not an
adversary who picks the exact bytes. Four classes are known-open **by
decision**: command substitution, operators glued to their neighbours,
executable paths that are not the basename, and filenames the shell composes
from pieces. Coverage across the three runtimes is not symmetric, and where it
differs that is luck rather than design — `enforce.js` carries a second regex
layer that the Codex twin does not. Six rounds of tokenizer hardening each found
another evasion of the same class while starting to interrupt ordinary work; the
layer that contains a determined adversary is the permission system above the
hook. Payloads the gate cannot evaluate fail closed. Per-runtime detail and the
measured evasion table live in the `CEILING` block at the top of each guard, and
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#5-hooks-em-runtime).

## Hook Tests

Smoke + correctness tests for the hooks and scripts (e.g. enforce, doctor, bootstrap).

```bash
node tests/run-all.js
```

## Setup on a New Machine

### System prerequisites

A fresh Mac needs these base tools on PATH first (commands assume [Homebrew](https://brew.sh)):

- **`node` (20+) + `git`** — required; the hooks and `node tests/run-all.js` won't run without `node`. In `all` mode `install.sh` skips the Cursor bootstrap when `node` is missing and continues. `doctor.sh` itself still runs and reports node as a FAIL, exiting non-zero. `brew install node git`
- **`codex` CLI** — required for the Codex harness. In `all` mode `install.sh` skips the Codex bootstrap when it is missing; `install.sh codex` fails loudly instead.
- **`rtk`** — required; the Rust Token Killer is enforced by a PreToolUse hook on Claude Code (`settings.json`), Codex (`codex/hooks.json`) and Cursor (`cursor/hooks.json`). **opencode registers no hooks**, so there RTK relies on the agent applying the prefix itself. `brew install rtk`. Name collision: the correct one is homebrew-core `rtk` (rtk-ai.app) — verify with `rtk gain` working + `which rtk`, not `reachingforthejack/rtk` (Rust Type Kit).
- **`graphify` + `graphify-mcp`** — required for the private durable Brain; installed from the validated `graphifyy[mcp]` package.
- **`bun`** — needed by gstack, on two harnesses with different severity. Codex: `install-codex-skills.sh` skips the gstack `./setup` step with a message and keeps going (non-fatal). Cursor: `bootstrap-cursor.sh` **exits 1** when the skill manifest contains gstack rows and `bun` is not on PATH. `brew install bun`.

Then run `scripts/install.sh` followed by `scripts/doctor.sh`.

`install.sh` targets every harness (Claude Code, opencode, Cursor, Codex) — no path
editing, works from any clone path. It is not all-or-nothing. In `all` mode three
things get a whole harness skipped, each announced before the run continues:

- `node` not on PATH → Cursor bootstrap skipped;
- `codex` CLI not on PATH → Codex bootstrap skipped;
- `bootstrap-opencode.sh` exits **3** — a deliberate refusal that wrote nothing —
  → opencode bootstrap skipped. Unlike the other two this cannot be probed up front,
  so the bootstrap runs and prints the reason and the repair steps first.

Any other non-zero exit is an unexpected failure and aborts even under `all`. Asked
for a harness explicitly, each one fails loudly instead of skipping. Several substeps
— gstack, karpathy, mattpocock, Graphify Brain — are optional and warn rather than
abort, while others are fatal (a missing `bun` with gstack rows in the Cursor manifest
makes `bootstrap-cursor.sh` exit 1). Read `scripts/install.sh` for the current
behavior, and read the `doctor.sh` output — it runs last in **every** mode, not only
`all`, and its exit code is `install.sh`'s exit code:

```bash
git clone https://github.com/debaotrader/jarvis-cortex-starter.git ~/.codex/jarvis-cortex
~/.codex/jarvis-cortex/scripts/install.sh           # claude → opencode → cursor → codex
~/.codex/jarvis-cortex/scripts/doctor.sh            # read-only health check (exit 0 = healthy)
```

`install.sh [claude|codex|opencode|cursor|all]` runs the matching bootstrap(s), then
`doctor.sh`. The private Brain is wired indirectly: `bootstrap-claude.sh` and
`bootstrap-codex.sh` each call `setup-graphify-brain.sh` best-effort (non-fatal, and
skippable with `SETUP_GRAPHIFY_BRAIN=0`); `install.sh` itself only prints a reminder.
Full details: [SETUP.md](SETUP.md).

For Codex on macOS only:

```bash
~/.codex/jarvis-cortex/scripts/bootstrap-codex.sh
```

Skill sync details: [docs/codex-skills-macbook.md](docs/codex-skills-macbook.md).

## Scripts

| Script | What it does |
|--------|--------------|
| `scripts/install.sh` | Unified entrypoint — runs per-harness bootstrap(s) + `doctor.sh`. `install.sh [claude\|codex\|opencode\|cursor\|all]`. |
| `scripts/doctor.sh` | Read-only cross-harness health check (dangling symlinks, settings.json hooks/statusLine, plugin sources, opencode/Cursor wiring). Exit 0 = healthy. |
| `scripts/bootstrap-claude.sh` | Symlinks the cortex into `~/.claude` (honors `CLAUDE_HOME`). |
| `scripts/bootstrap-codex.sh` | Wires the cortex into `~/.codex` (honors `CODEX_HOME`; needs the `codex` CLI). Pins every destination it passes to `install-codex-skills.sh` so none is inherited from the environment; that installer still honors `CODEX_HOME`, `GSTACK_*` and `AGENTS_TARGET_SKILLS` on **direct** invocation, which is the deliberate fork escape hatch. |
| `scripts/bootstrap-opencode.sh` | **Create-or-refuse** for `~/.config/opencode/opencode.jsonc`: writes a fresh config where there is none, no-ops when the jarvis-managed block is already current, and refuses on anything else. It never rewrites an existing file, so there is no backup to look for. Exit contract: `0` success, `1` unexpected failure (may follow a partial publication — stderr is the authority on what exists, not the status), `2` usage error, `3` deliberate refusal, nothing written. Refusal classes and the repair path: §3 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). |
| `scripts/bootstrap-cursor.sh` | Wires hooks, MCP, rules and a curated native skill manifest into `~/.cursor` (honors `CURSOR_HOME`). Cursor-only setup does not require Claude; the doctor requires third-party imports to be explicitly disabled. |
| `scripts/setup-graphify-brain.sh` | Registers the official `graphify-brain` MCP in Claude Code and Codex and enforces the Brain Git-hook policy. |

**None of these delete anything you had.** The shared `link_file` leaves an
existing symlink alone when it already points exactly at our source, unlinks one
only when it is provably a physical alias of that same source (the single
owner-approved exception), and **parks** everything else — moving it into a
reserved slot under `backups/` with its inode intact — before the managed link
takes the path. No content comparison ever decides a removal.
`install-codex-skills.sh` follows the same policy and does not even carry the
alias unlink. `bootstrap-opencode.sh` is the outlier and needs no policy: it
never touches an existing file at all. Declared and accepted: every park
reserves a fresh timestamped slot and nothing prunes them, so `backups/` grows
until you clear it by hand — it holds your displaced files, not cache.

## Private

This repo contains personal agent configuration. Not intended for public use.
