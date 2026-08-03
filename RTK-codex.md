# RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands, enforced by the Codex
`PreToolUse` hook.

## Automatic Rewrite

The global `Bash` hook runs the Jarvis Codex adapter, which delegates to
`rtk hook claude` and normalizes its output to the Codex `PreToolUse` schema.
It rewrites supported commands before execution. Write normal shell commands;
do not add a second `rtk` prefix when the hook is active. Unsupported commands
pass through unchanged.

When running outside the Codex harness, prefix supported commands with `rtk`
manually.

Prefer RTK specialized filters over generic wrapped commands. They save more
tokens and usually preserve the useful failure signal better.

Examples:

```bash
git status
git diff
vitest run
eslint .
cat path/to/file
pytest -q
```

Use `rtk proxy <cmd>` only for diagnostics or when a specialized filter breaks
the command. `proxy` tracks usage but does not compress output.

## Meta Commands

```bash
rtk gain            # Token savings analytics
rtk proxy <cmd>     # Run raw command without filtering
```

`rtk gain --history` is sensitive diagnostics. Use only when the task explicitly needs recent command history.

## Verification

```bash
rtk --version
rtk gain
which rtk
~/.codex/jarvis-cortex/scripts/verify-rtk-codex-hook.sh
```
