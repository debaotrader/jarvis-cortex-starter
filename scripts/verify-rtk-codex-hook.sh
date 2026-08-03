#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_PATH="${1:-$SCRIPT_DIR/rtk-codex-hook.js}"
RTK_BIN="${2:-rtk}"
CODEX_BIN="${3:-codex}"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "codex not found in PATH" >&2
  exit 1
fi

if ! "$CODEX_BIN" features list 2>/dev/null | awk '$1 == "hooks" && $NF == "true" { found = 1 } END { exit !found }'; then
  echo "Codex hooks feature is unavailable or disabled" >&2
  exit 1
fi

if ! command -v "$RTK_BIN" >/dev/null 2>&1; then
  echo "rtk not found in PATH" >&2
  exit 1
fi

probe_input='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}'
probe_output="$(printf '%s' "$probe_input" | node "$ADAPTER_PATH" "$RTK_BIN" 2>/dev/null)"

node -e '
  const output = JSON.parse(process.argv[1]);
  const hookOutput = output?.hookSpecificOutput;
  const command = hookOutput?.updatedInput?.command;
  if (command !== "rtk git status") {
    console.error(`unexpected RTK rewrite: ${JSON.stringify(command)}`);
    process.exit(1);
  }
  if (hookOutput.permissionDecision !== "allow") {
    console.error(`unexpected RTK permission decision: ${JSON.stringify(hookOutput.permissionDecision)}`);
    process.exit(1);
  }
' "$probe_output"

printf 'rtk Codex adapter contract probe passed (%s)\n' "$("$RTK_BIN" --version)"
