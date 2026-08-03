#!/usr/bin/env bash
set -euo pipefail

# Install mattpocock skills (github.com/mattpocock/skills, MIT) into a target
# skills dir by symlinking each active skill from a local clone cache.
#
# Best-effort / non-fatal: a missing git, a failed clone or a failed pull WARN to
# stderr and the script still exits 0, so a caller (bootstrap-claude/codex) can
# wire it without risking the cortex's own promoted skills. We install ONLY the
# active categories (engineering, productivity, misc) and EXCLUDE the `caveman`
# skill, which collides with the caveman PLUGIN the cortex already uses.
#
# Usage: install-mattpocock-skills.sh [<target_skills_dir>]
#   default target: ${CLAUDE_HOME:-$HOME/.claude}/skills

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

TARGET_SKILLS="${1:-${MATTPOCOCK_TARGET:-${CLAUDE_HOME:-$HOME/.claude}/skills}}"
MATTPOCOCK_REPO="${MATTPOCOCK_REPO:-https://github.com/mattpocock/skills.git}"

# Active categories to install. Anything outside these (deprecated, in-progress,
# personal) is never installed.
ACTIVE_CATEGORIES="engineering productivity misc"
# Skills to skip even inside active categories. caveman collides with the plugin.
EXCLUDE_SKILLS="caveman"

ensure_under() {
  local path="$1"
  local parent="$2"
  local resolved_path
  local resolved_parent
  resolved_path="$(cd -- "$(dirname -- "$path")" && pwd)/$(basename -- "$path")"
  resolved_parent="$(cd -- "$parent" && pwd)"

  case "$resolved_path" in
    "$resolved_parent"/*) ;;
    *) echo "Refusing to operate outside expected directory: $resolved_path" >&2; exit 1 ;;
  esac
}

is_excluded_skill() {
  local name="$1"
  case " $EXCLUDE_SKILLS " in
    *" $name "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Cache the clone OUTSIDE the skills dir so it isn't treated as a skill itself.
# Derive a home from the target (…/.claude/skills -> …/.claude). Honor CLAUDE/CODEX
# home env when present so the cache lands beside the harness that owns the dir.
target_home="$(dirname -- "$TARGET_SKILLS")"
CACHE_DIR="${MATTPOCOCK_CACHE:-$target_home/.cache/mattpocock-skills}"

mkdir -p "$TARGET_SKILLS"

# --- Clone or update the cache (best-effort) -------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "warn: mattpocock skills skipped — git not found in PATH." >&2
  exit 0
fi

mkdir -p "$(dirname -- "$CACHE_DIR")"

clone_ok=1
if [ -d "$CACHE_DIR/.git" ]; then
  # Force the configured origin so a MATTPOCOCK_REPO override always takes effect
  # even on an existing cache (otherwise pull would silently reuse the old URL).
  git -C "$CACHE_DIR" remote set-url origin "$MATTPOCOCK_REPO" \
    || { echo "warn: mattpocock cache remote set-url failed." >&2; clone_ok=0; }
  if [ "$clone_ok" = "1" ]; then
    git -C "$CACHE_DIR" pull --ff-only \
      || { echo "warn: mattpocock cache pull failed (network/repo?); skipping install." >&2; clone_ok=0; }
  fi
else
  if [ -e "$CACHE_DIR" ] || [ -L "$CACHE_DIR" ]; then
    ensure_under "$CACHE_DIR" "$(dirname -- "$CACHE_DIR")"
    rm -rf "$CACHE_DIR"
  fi
  git clone --depth 1 "$MATTPOCOCK_REPO" "$CACHE_DIR" \
    || { echo "warn: mattpocock clone failed (network/repo?); skipping install." >&2; clone_ok=0; }
fi

if [ "$clone_ok" != "1" ]; then
  # Non-fatal: warn already emitted, exit cleanly so callers/bootstrap continue.
  exit 0
fi

if [ ! -d "$CACHE_DIR/skills" ]; then
  echo "warn: mattpocock cache has no skills/ dir at $CACHE_DIR; skipping install." >&2
  exit 0
fi

# --- Symlink active skills into the target (idempotent) --------------------
installed=0
skipped_collision=0
for category in $ACTIVE_CATEGORIES; do
  cat_dir="$CACHE_DIR/skills/$category"
  [ -d "$cat_dir" ] || continue
  for skill_dir in "$cat_dir"/*/; do
    [ -d "$skill_dir" ] || continue
    name="$(basename -- "$skill_dir")"
    # A skill dir must contain a SKILL.md (skips category README dirs, etc.).
    [ -f "$skill_dir/SKILL.md" ] || continue
    if is_excluded_skill "$name"; then
      continue
    fi

    # Resolve the source to an absolute path for a stable readlink comparison.
    source="$(cd -- "$skill_dir" && pwd)"
    target="$TARGET_SKILLS/$name"

    if [ -L "$target" ]; then
      current="$(readlink "$target")"
      if [ "$current" = "$source" ]; then
        installed=$((installed + 1))
        continue
      fi
      case "$current" in
        "$CACHE_DIR"/*)
          # An older mattpocock link into our own cache — safe to re-point.
          ensure_under "$target" "$TARGET_SKILLS"
          ln -sfn "$source" "$target"
          installed=$((installed + 1))
          ;;
        *)
          # A symlink we don't own — never clobber it.
          echo "warn: skipping '$name' — existing symlink not managed by mattpocock installer ($current)." >&2
          skipped_collision=$((skipped_collision + 1))
          ;;
      esac
      continue
    fi

    if [ -e "$target" ]; then
      # A real dir/file we didn't create — never clobber it.
      echo "warn: skipping '$name' — a non-symlink already exists at $target." >&2
      skipped_collision=$((skipped_collision + 1))
      continue
    fi

    ensure_under "$target" "$TARGET_SKILLS"
    ln -sfn "$source" "$target"
    installed=$((installed + 1))
  done
done

echo "Installed $installed mattpocock skills into $TARGET_SKILLS"
echo "Skipped: caveman skill (caveman plugin owns it), deprecated/in-progress/personal categories."
if [ "$skipped_collision" -gt 0 ]; then
  echo "Skipped $skipped_collision name collision(s) with skills not managed by this installer (see warns above)."
fi
echo "Cache: $CACHE_DIR"
