# RTK - Rust Token Killer

**Usage**: Token-optimized CLI proxy (60-90% savings on dev operations)

## Meta Commands (always use rtk directly)

```bash
rtk gain              # Show token savings analytics
rtk discover          # Analyze Claude Code history for missed opportunities
rtk proxy <cmd>       # Execute raw command without filtering (for debugging)
```

`rtk gain --history` is sensitive diagnostics. Use only when the task explicitly needs recent command history.

## Savings Routing

Prefer RTK specialized filters over generic wrapped commands:

```bash
rtk diff              # Better than rtk git diff for large diffs
rtk vitest run        # Better than proxying vitest
rtk lint eslint       # Better than raw eslint output
rtk read path/to/file # Better than cat/sed for large files
rtk tsc --noEmit      # TypeScript errors grouped compactly
```

Use `rtk proxy <cmd>` only for diagnostics or when a specialized filter breaks
the command. `proxy` tracks usage but does not compress output.

## Installation Verification

```bash
rtk --version         # Should show: rtk X.Y.Z
rtk gain              # Should work (not "command not found")
which rtk             # Verify correct binary
```

⚠️ **Name collision**: If `rtk gain` fails, you may have reachingforthejack/rtk (Rust Type Kit) installed instead.

## Hook-Based Usage

All other commands are automatically rewritten by the Claude Code hook.
Example: `git status` → `rtk git status` (transparent, 0 tokens overhead)

Refer to CLAUDE.md for full command reference.
