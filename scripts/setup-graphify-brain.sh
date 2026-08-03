#!/usr/bin/env bash
# Register the private Jarvis Brain through Graphify's official project and MCP
# integrations. Idempotent and safe to rerun after moving machines or binaries.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MODE="${1:---all}"

usage() {
  cat <<'EOF'
Usage: setup-graphify-brain.sh [--all|--claude|--codex]

Register the private Jarvis Brain through Graphify's official integrations.
The Brain defaults to ~/.jarvis/brain and can be overridden with
JARVIS_BRAIN_HOME or graphifyBrainPath in the Cortex config.
EOF
}

case "$MODE" in
  --all|--claude|--codex) ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown argument: $MODE" >&2
    exit 2
    ;;
esac

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node executable not found; it is required to validate Cortex and Brain JSON." >&2
  exit 1
fi

resolve_brain_home() {
  if [ -n "${JARVIS_BRAIN_HOME:-}" ]; then
    printf '%s\n' "$JARVIS_BRAIN_HOME"
    return
  fi

  local config_path="${JARVIS_CORTEX_CONFIG:-$CLAUDE_HOME/config.json}"
  if [ -f "$config_path" ]; then
    local configured
    if ! configured="$("$NODE_BIN" "$SCRIPT_DIR/graphify-brain-config.js" config-path "$config_path" 2>/dev/null)"; then
      echo "Cortex config is invalid: $config_path" >&2
      return 1
    fi
    if [ -n "$configured" ]; then
      configured="${configured/#\~/$HOME}"
      printf '%s\n' "$configured"
      return
    fi
  fi

  printf '%s/.jarvis/brain\n' "$HOME"
}

BRAIN_HOME="$(resolve_brain_home)"
GRAPH_PATH="$BRAIN_HOME/graphify-out/graph.json"
GRAPHIFY_BIN="${GRAPHIFY_BIN:-$(command -v graphify 2>/dev/null || true)}"
GRAPHIFY_MCP_BIN="${GRAPHIFY_MCP_BIN:-$(command -v graphify-mcp 2>/dev/null || true)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"

if ! git -C "$BRAIN_HOME" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Jarvis Brain Git repository not found: $BRAIN_HOME" >&2
  echo "Clone the private Brain there or set JARVIS_BRAIN_HOME." >&2
  exit 1
fi
if [ ! -s "$GRAPH_PATH" ]; then
  echo "Jarvis Brain graph missing or empty: $GRAPH_PATH" >&2
  exit 1
fi
if [ -z "$GRAPHIFY_BIN" ] || [ ! -x "$GRAPHIFY_BIN" ]; then
  echo "graphify executable not found; install the validated graphifyy runtime." >&2
  exit 1
fi
if [ -z "$GRAPHIFY_MCP_BIN" ] || [ ! -x "$GRAPHIFY_MCP_BIN" ]; then
  echo "graphify-mcp executable not found; install graphifyy with the mcp extra." >&2
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/graphify-brain-config.js" validate-graph "$GRAPH_PATH" >/dev/null

claude_mcp_matches() {
  local output="$1"
  printf '%s' "$output" \
    | "$NODE_BIN" "$SCRIPT_DIR/graphify-brain-config.js" \
      validate-claude-mcp "$GRAPHIFY_MCP_BIN" "$GRAPH_PATH" >/dev/null 2>&1
}

codex_mcp_matches() {
  local output="$1"
  printf '%s' "$output" \
    | "$NODE_BIN" "$SCRIPT_DIR/graphify-brain-config.js" \
      validate-codex-mcp "$GRAPHIFY_MCP_BIN" "$GRAPH_PATH" >/dev/null 2>&1
}

install_claude() {
  if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
    echo "claude CLI not found; cannot register graphify-brain for Claude Code." >&2
    exit 1
  fi
  (cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" claude install)
  local current=""
  if current="$("$CLAUDE_BIN" mcp get graphify-brain 2>/dev/null)"; then
    if ! claude_mcp_matches "$current"; then
      echo "Claude Code already has a different graphify-brain registration; preserving it." >&2
      echo "Remove it explicitly with 'claude mcp remove graphify-brain -s user', then rerun setup." >&2
      exit 1
    fi
    return
  fi
  "$CLAUDE_BIN" mcp add --scope user graphify-brain -- \
    "$GRAPHIFY_MCP_BIN" --graph "$GRAPH_PATH"
  current="$("$CLAUDE_BIN" mcp get graphify-brain)"
  if ! claude_mcp_matches "$current"; then
    echo "Claude Code graphify-brain registration did not verify after creation." >&2
    exit 1
  fi
}

install_codex() {
  if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
    echo "codex CLI not found; cannot register graphify-brain for Codex." >&2
    exit 1
  fi
  (cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" codex install)
  local current=""
  if current="$("$CODEX_BIN" mcp get graphify-brain --json 2>/dev/null)" \
    && codex_mcp_matches "$current"; then
    return
  fi
  "$CODEX_BIN" mcp add graphify-brain -- \
    "$GRAPHIFY_MCP_BIN" --graph "$GRAPH_PATH"
  current="$("$CODEX_BIN" mcp get graphify-brain --json)"
  if ! codex_mcp_matches "$current"; then
    echo "Codex graphify-brain registration did not verify after creation." >&2
    exit 1
  fi
}

case "$MODE" in
  --claude) install_claude ;;
  --codex) install_codex ;;
  --all)
    install_claude
    install_codex
    ;;
esac

# Native Git hooks rebuild AST/code graphs. They are intentionally disabled in
# the Markdown Brain because semantic updates require the Graphify agent skill.
(cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" hook uninstall >/dev/null)
if ! hook_status="$(cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" hook status)"; then
  echo "Could not verify Graphify Git-hook status in the Markdown Brain." >&2
  exit 1
fi
expected_hook_status=$'post-commit: not installed\npost-checkout: not installed'
if [ "$hook_status" != "$expected_hook_status" ]; then
  echo "Graphify Git-hook status is not the expected disabled state:" >&2
  printf '%s\n' "$hook_status" >&2
  exit 1
fi

git -C "$BRAIN_HOME" config merge.graphify.name "Graphify graph union merge"
git -C "$BRAIN_HOME" config merge.graphify.driver \
  "$GRAPHIFY_BIN merge-driver %O %A %B"

"$GRAPHIFY_BIN" explain "Jarvis Brain" --graph "$GRAPH_PATH" >/dev/null

echo "Graphify Brain integration complete."
echo "Brain: $BRAIN_HOME"
echo "Graph: $GRAPH_PATH"
echo "Mode: $MODE"
