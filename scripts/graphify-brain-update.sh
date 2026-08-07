#!/usr/bin/env bash
# Re-extract the private Jarvis Brain into its knowledge graph after new
# Markdown lands there. Complements setup-graphify-brain.sh, which only
# REGISTERS the MCP server — it never regenerates the graph the server reads.
#
# Usage:
#   graphify-brain-update.sh              # extract, re-cluster, label
#   graphify-brain-update.sh -h | --help
#
# There is deliberately no extract-only mode. `graphify . --update` writes the
# RAW graph: measured, it stripped `community_name` from every node that
# `graphify label` had previously written, and shrank .graphify_analysis.json.
# Extract-then-stop is a valid INTERMEDIATE state, never a terminal one — so
# offering it as a mode would hand the caller a quietly degraded graph, which
# the MCP would then serve as if it were complete.
#
# The LLM key is READ FROM DISK at runtime and never stored in this repo:
# opencode already keeps one in ~/.local/share/opencode/auth.json. Export
# OPENAI_API_KEY yourself to use a different provider instead.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MODE="${1:---all}"

usage() {
  cat <<'EOF'
Usage: graphify-brain-update.sh [--all]

Re-extract the private Jarvis Brain into graphify-out/graph.json, then
re-cluster and name communities. Runs as one unit: extract alone leaves the
graph without community names.

Brain path: JARVIS_BRAIN_HOME, then graphifyBrainPath in the Cortex config,
then ~/.jarvis/brain.
EOF
}

case "$MODE" in
  --all) ;;
  -h|--help) usage; exit 0 ;;
  *) echo "Unknown argument: $MODE" >&2; exit 2 ;;
esac

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node executable not found; it is required to resolve the Brain and the key." >&2
  exit 1
fi

# Same resolution order as setup-graphify-brain.sh. Kept in sync deliberately:
# a script that regenerates a DIFFERENT graph than the one the MCP serves is
# worse than one that refuses to run.
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
GRAPHIFY_BIN="${GRAPHIFY_BIN:-$(command -v graphify 2>/dev/null || true)}"

if ! git -C "$BRAIN_HOME" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Jarvis Brain Git repository not found: $BRAIN_HOME" >&2
  echo "Clone the private Brain there or set JARVIS_BRAIN_HOME." >&2
  exit 1
fi
if [ -z "$GRAPHIFY_BIN" ] || [ ! -x "$GRAPHIFY_BIN" ]; then
  echo "graphify executable not found; run 'scripts/install.sh graphify' first." >&2
  exit 1
fi

# The `openai` extra is NOT part of a default graphifyy install: the first run
# against this gateway failed with "the 'openai' package is required for this
# backend but is not installed". Detect it here instead of after the scan, so
# the failure names its own fix. Pin to the installed version — an unpinned
# --force can move the binary that setup-graphify-brain.sh validates the MCP
# registration against.
#
# The interpreter comes from graphify's own shebang, not from walking up from
# the launcher: `uv tool` installs the launcher in ~/.local/bin while the
# environment lives under ~/.local/share/uv/tools/graphifyy/, so `dirname`
# twice plus /bin/python names a path that does not exist and the check would
# silently skip. A launcher with no shebang (a compiled binary) also skips —
# by design, since then there is no interpreter to interrogate.
GRAPHIFY_PY=""
case "$(head -c 2 -- "$GRAPHIFY_BIN" 2>/dev/null || true)" in
  '#!') GRAPHIFY_PY="$(head -n 1 -- "$GRAPHIFY_BIN" | sed 's/^#![[:space:]]*//; s/[[:space:]].*$//')" ;;
esac
if [ -n "$GRAPHIFY_PY" ] && [ -x "$GRAPHIFY_PY" ] && ! "$GRAPHIFY_PY" -c 'import openai' >/dev/null 2>&1; then
  graphify_version="$("$GRAPHIFY_BIN" --version 2>/dev/null | awk '{print $2}')"
  echo "graphify lacks the 'openai' extra required by this backend." >&2
  # BOTH extras, and the mcp pin. Installing "graphifyy[openai]" alone drops
  # the mcp package and leaves graphify-mcp importing a name that no longer
  # exists — measured. See the README for why mcp is pinned below 2.
  echo "Fix: uv tool install --python 3.12 \\" >&2
  echo "       \"graphifyy[mcp,openai]==${graphify_version:-<version>}\" --with \"mcp<2\" --force" >&2
  exit 1
fi

# Endpoint. The two Zen base URLs are one path segment apart and are NOT
# interchangeable: https://opencode.ai/zen/v1 is the metered workspace and
# answered 401 CreditsError, while https://opencode.ai/zen/go/v1 is the one the
# auth.json `opencode-go` key authenticates against and answered 200. Picking
# the shorter-looking URL is the obvious wrong guess — hence this note.
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://opencode.ai/zen/go/v1}"
# deepseek-v4-pro, not -flash: flash's upstream answered 503 "Endpoint is
# unavailable" on this gateway across every token budget while pro answered
# 200 on the same key. Both are reasoning models — they spend the completion
# budget on reasoning_content before emitting content, so a small max_tokens
# yields an EMPTY extraction rather than an error. Override with GRAPHIFY_MODEL.
OPENAI_MODEL="${GRAPHIFY_MODEL:-${OPENAI_MODEL:-deepseek-v4-pro}}"

if [ -z "${OPENAI_API_KEY:-}" ]; then
  OPENCODE_AUTH="${OPENCODE_AUTH:-$HOME/.local/share/opencode/auth.json}"
  if [ ! -f "$OPENCODE_AUTH" ]; then
    echo "No OPENAI_API_KEY set and no opencode credentials at $OPENCODE_AUTH." >&2
    echo "Export OPENAI_API_KEY, or sign in with 'opencode auth login'." >&2
    exit 1
  fi
  # Read-only, single field, printed to a variable and never to a stream.
  OPENAI_API_KEY="$("$NODE_BIN" -e '
    const fs = require("fs");
    let auth;
    try { auth = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { process.exit(1); }
    const entry = auth["opencode-go"];
    if (!entry || !entry.key) process.exit(1);
    process.stdout.write(entry.key);
  ' "$OPENCODE_AUTH")" || {
    echo "opencode credentials at $OPENCODE_AUTH carry no 'opencode-go' key." >&2
    echo "Export OPENAI_API_KEY instead, or re-run 'opencode auth login'." >&2
    exit 1
  }
fi
export OPENAI_BASE_URL OPENAI_MODEL OPENAI_API_KEY

echo "Brain:    $BRAIN_HOME"
echo "Endpoint: $OPENAI_BASE_URL"
echo "Model:    $OPENAI_MODEL"
echo ""

# From here the graph on disk is mid-flight. `set -e` would exit silently and
# leave graph.json without community names, so name that state on the way out.
# The trap is armed only for this window and disarmed once labeling lands.
UNLABELED_WARNING=1
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${UNLABELED_WARNING:-0}" -eq 1 ]; then
    echo "" >&2
    echo "graph.json was rewritten but community naming did not finish: the graph" >&2
    echo "on disk has no community names and the MCP will serve it that way." >&2
    echo "Re-run this script, or restore from $BRAIN_HOME/graphify-out/<date>/." >&2
  fi
  return "$rc"
}
trap on_exit EXIT

(cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" . --update --backend openai)
(cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" cluster-only . --backend openai --model "$OPENAI_MODEL")
(cd "$BRAIN_HOME" && "$GRAPHIFY_BIN" label . --backend openai --model "$OPENAI_MODEL")
UNLABELED_WARNING=0

echo ""
echo "Graph updated. Review before committing — 'git add -A' in the Brain has"
echo "previously staged macOS 'name 2.ext' duplicates from a bulk write:"
echo "  git -C $BRAIN_HOME status --short"
