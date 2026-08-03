#!/usr/bin/env bash
# update-tools.sh — keep token-saving tooling fresh.
# Updates: rtk (brew) + caveman plugin (claude CLI).
# Run weekly via launchd (com.jarvis.update-tools) or manually.
set -uo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_SOURCE" ]; do
  SCRIPT_SOURCE_DIR="$(cd -P -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  case "$SCRIPT_SOURCE" in
    /*) ;;
    *) SCRIPT_SOURCE="$SCRIPT_SOURCE_DIR/$SCRIPT_SOURCE" ;;
  esac
done
SCRIPT_DIR="$(cd -P -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd)"
CORTEX="$(cd -P -- "$SCRIPT_DIR/.." && pwd)"

# launchd runs with a minimal PATH; make brew/rtk/claude/node reachable.
# node lives only under fnm (not in /opt/homebrew); use the stable default-alias
# path (survives node version bumps) — without it the cortex-sync branch can't run headless.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/fnm/aliases/default/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$PATH"

LOG="$HOME/.claude/logs/update-tools.log"
mkdir -p "$(dirname "$LOG")"
ts() { date "+%Y-%m-%d %H:%M:%S"; }

{
  echo "=== $(ts) update-tools start ==="

  # --- rtk via Homebrew ---
  if command -v brew >/dev/null 2>&1; then
    brew update >/dev/null 2>&1 || echo "[rtk] brew update failed (continuing)"
    echo "[rtk] before: $(rtk --version 2>/dev/null || echo 'not installed')"
    brew upgrade rtk 2>&1 || echo "[rtk] brew upgrade rtk failed"
    echo "[rtk] after:  $(rtk --version 2>/dev/null || echo 'not installed')"
  else
    echo "[rtk] brew NOT in PATH — skipped"
  fi

  # --- caveman plugin via Claude Code CLI (Claude Code surface) ---
  if command -v claude >/dev/null 2>&1; then
    claude plugin marketplace update caveman 2>&1 || echo "[caveman] marketplace update failed"
    claude plugin update caveman@caveman 2>&1 || echo "[caveman] plugin update failed"
  else
    echo "[caveman] claude CLI NOT in PATH — skipped"
  fi

  # --- sync caveman skills into cortex so Codex stays fresh too ---
  # Codex consumes caveman as vendored skills symlinked from the cortex repo
  # (~/.codex/skills/* -> jarvis-cortex/codex/agent-skills/*). The plugin update
  # above only touches the Claude Code cache, so mirror it into the cortex here.
  CORTEX_GIT_ROOT=$(git -C "$CORTEX" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$CORTEX_GIT_ROOT" ]; then
    CORTEX_GIT_ROOT=$(cd -P -- "$CORTEX_GIT_ROOT" 2>/dev/null && pwd || true)
  fi
  # node stderr flows to the log (block-level redirect), not swallowed, so a
  # resolution failure is visible instead of silently degrading to "skipped".
  PCAV=$(node -e "const j=require('$HOME/.claude/plugins/installed_plugins.json');const a=j.plugins['caveman@caveman'];if(a&&a[0])process.stdout.write(a[0].installPath)")
  if [ -z "$PCAV" ]; then
    echo "[caveman-codex] could not resolve plugin installPath (node missing on PATH or JSON unreadable) — sync skipped"
  elif [ ! -d "$PCAV/skills" ]; then
    echo "[caveman-codex] plugin skills dir missing at $PCAV — skipped"
  elif [ "$CORTEX_GIT_ROOT" != "$CORTEX" ]; then
    echo "[caveman-codex] resolved cortex is not the Git worktree root ($CORTEX) — skipped"
  elif [ ! -d "$CORTEX/codex/agent-skills" ]; then
    echo "[caveman-codex] cortex agent-skills dir missing — skipped"
  elif ! command -v rsync >/dev/null 2>&1; then
    echo "[caveman-codex] rsync missing — skipped"
  else
    for sk in "$PCAV"/skills/*/; do
      name=$(basename "$sk")
      [ "$name" = "*" ] && continue   # nullglob guard: no skills matched
      mkdir -p "$CORTEX/codex/agent-skills/$name"
      rsync -a --delete "$sk" "$CORTEX/codex/agent-skills/$name/"
    done
    if [ -n "$(git -C "$CORTEX" status --porcelain codex/agent-skills 2>/dev/null)" ]; then
      git -C "$CORTEX" add codex/agent-skills 2>&1
      git -C "$CORTEX" commit -m "chore(codex): sync caveman skills from plugin $(basename "$PCAV")" -- codex/agent-skills 2>&1
      git -C "$CORTEX" push 2>&1 || echo "[caveman-codex] push FAILED (commit kept local; push manually)"
    else
      echo "[caveman-codex] cortex caveman already in sync"
    fi
  fi

  echo "=== $(ts) update-tools done ==="
  echo ""
} >> "$LOG" 2>&1
