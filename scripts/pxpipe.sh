#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-47821}"
PXPIPE_URL="${PXPIPE_URL:-http://127.0.0.1:$PORT}"
CLAUDE_APP_NAME="${CLAUDE_APP_NAME:-Claude}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_MODELS="claude-fable-5"

usage() {
  cat <<EOF
Usage: scripts/pxpipe.sh <command> [args...]

Commands:
  start             Start the pxpipe proxy in the foreground.
  status            Check whether the local dashboard responds.
  stats             Show measured token and cost savings.
  claude [args...]  Run Claude Code CLI through pxpipe.
  claude-app-on     Point future Claude.app launches at pxpipe via launchctl.
  claude-app-off    Remove the Claude.app launchctl override.
  claude-app-open   Set the override and open Claude.app.

Environment:
  PORT              pxpipe port (default 47821)
  PXPIPE_URL        proxy base URL (default http://127.0.0.1:\$PORT)
  CLAUDE_APP_NAME   macOS app name for open -a (default Claude)
  PXPIPE_MODELS     Claude model allowlist; non-Claude entries are rejected
                    default: claude-fable-5; use "off" to disable imaging
  PXPIPE_ALLOW_DEGRADED_MODELS
                    set to 1 to test degraded Claude models explicitly
EOF
}

require_pxpipe() {
  if ! command -v pxpipe >/dev/null 2>&1; then
    echo "pxpipe not found. Run scripts/install-pxpipe.sh first." >&2
    exit 1
  fi
}

require_metrics_tools() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found; it is required to read pxpipe metrics." >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node not found; it is required to format pxpipe metrics." >&2
    exit 1
  fi
}

apply_model_policy() {
  if [ "${PXPIPE_MODELS+x}" != "x" ]; then
    PXPIPE_MODELS="$DEFAULT_MODELS"
  fi
  export PXPIPE_MODELS
  models_compact="${PXPIPE_MODELS//[[:space:]]/}"

  if [ -z "$models_compact" ]; then
    echo "invalid PXPIPE_MODELS list: at least one Claude model or 'off' is required." >&2
    exit 1
  fi

  if [ "$models_compact" != "off" ]; then
    case "$models_compact" in
      ,*|*,|*,,*)
        echo "invalid PXPIPE_MODELS list: empty model entries are not allowed." >&2
        exit 1
        ;;
    esac

    IFS=',' read -r -a configured_models <<<"$models_compact"
    for model in "${configured_models[@]}"; do
      case "$model" in
        claude-?*) ;;
        *)
          echo "pxpipe refused non-Claude model '$model': Jarvis uses a Claude-only policy." >&2
          echo "Run other model families normally, without pxpipe." >&2
          exit 1
          ;;
      esac
    done
  fi

  case ",$models_compact," in
    *,claude-opus-4-8,*|*,claude-opus-4-8-*,*)
      if [ "${PXPIPE_ALLOW_DEGRADED_MODELS:-0}" != "1" ]; then
        echo "pxpipe refused PXPIPE_MODELS=$PXPIPE_MODELS due to documented quality degradation." >&2
        echo "Use the conservative default ($DEFAULT_MODELS), or set PXPIPE_ALLOW_DEGRADED_MODELS=1 for an explicit experiment." >&2
        exit 1
      fi
      ;;
  esac
}

case "${1:-}" in
  start)
    require_pxpipe
    apply_model_policy
    exec pxpipe
    ;;
  status)
    if command -v curl >/dev/null 2>&1 && curl --max-time 3 -fsS "$PXPIPE_URL/" >/dev/null 2>&1; then
      echo "pxpipe dashboard is reachable at $PXPIPE_URL/"
    else
      echo "pxpipe dashboard is not reachable at $PXPIPE_URL/"
      exit 1
    fi
    ;;
  stats)
    require_metrics_tools
    events_file="${PXPIPE_LOG:-$HOME/.pxpipe/events.jsonl}"
    if ! stats_json="$(curl --max-time 3 -fsS "$PXPIPE_URL/proxy-stats" 2>/dev/null)"; then
      if [ -s "$events_file" ]; then
        stats_json='{"requests":0}'
      else
        echo "pxpipe stats are unavailable at $PXPIPE_URL and no event history was found." >&2
        exit 1
      fi
    fi
    node "$SCRIPT_DIR/pxpipe-stats.js" "$stats_json" "$events_file"
    ;;
  claude)
    shift
    require_pxpipe
    if ! command -v claude >/dev/null 2>&1; then
      echo "claude CLI not found in PATH." >&2
      exit 1
    fi
    export ANTHROPIC_BASE_URL="$PXPIPE_URL"
    exec claude "$@"
    ;;
  claude-app-on)
    launchctl setenv ANTHROPIC_BASE_URL "$PXPIPE_URL"
    echo "Claude.app launch environment set: ANTHROPIC_BASE_URL=$PXPIPE_URL"
    echo "Start pxpipe first with scripts/pxpipe.sh start, then restart Claude.app."
    ;;
  claude-app-off)
    launchctl unsetenv ANTHROPIC_BASE_URL
    echo "Claude.app launch environment override removed."
    ;;
  claude-app-open)
    launchctl setenv ANTHROPIC_BASE_URL "$PXPIPE_URL"
    open -a "$CLAUDE_APP_NAME"
    echo "Opened $CLAUDE_APP_NAME with future launch environment pointing at $PXPIPE_URL"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
