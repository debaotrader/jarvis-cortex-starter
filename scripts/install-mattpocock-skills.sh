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
# The commit this cortex is validated against — the one already on the owner's
# machine when the pin was introduced (2026-07-16). Bumping it is a deliberate
# act: read the upstream diff, then update this line and
# active/contexts/mattpocock-skills.md together, because that routing file
# names skills by hand and upstream renames them.
# Override with a SHA, tag or branch; a non-SHA skips the equality check below.
MATTPOCOCK_REF="${MATTPOCOCK_REF:-9603c1cc8118d08bc1b3bf34cf714f62178dea3b}"

# Active categories to install. Anything outside these (deprecated, in-progress,
# personal) is never installed.
ACTIVE_CATEGORIES="engineering productivity misc"
# Skills to skip even inside active categories. caveman collides with the plugin.
EXCLUDE_SKILLS="caveman"

ensure_under() {
  # `local CDPATH=` plus `builtin cd -P`/`builtin pwd -P`, matching
  # install-codex-skills.sh: with CDPATH set, `cd` PRINTS the directory it
  # selected and that line lands inside these captures, giving two lines where
  # one is required. A LOGICAL cd/pwd reports the pretty path, so a symlinked
  # component would compare as if it were where it is SPELLED rather than where
  # it LANDS — and this guard now fronts a `mv`, so a wrong answer moves a real
  # object. Both operands resolve the same way, so an ordinary symlinked home
  # still matches itself.
  local CDPATH=
  local path="$1"
  local parent="$2"
  local resolved_path
  local resolved_parent
  resolved_path="$(builtin cd -P -- "$(dirname -- "$path")" && builtin pwd -P)/$(basename -- "$path")"
  resolved_parent="$(builtin cd -P -- "$parent" && builtin pwd -P)"

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
# Beside the skills dir's own home, the same shape install-codex-skills.sh uses
# ($CODEX_HOME/backups/skills): ~/.claude/backups/skills for Claude,
# ~/.codex/backups/skills for Codex.
MATTPOCOCK_BACKUP_DIR="${MATTPOCOCK_BACKUP_DIR:-$target_home/backups/skills}"

# Park anything occupying a managed target instead of skipping it.
#
# Skipping exited 0 while installing nothing, so a name that collided stayed on
# whatever version happened to be on disk — and this installer's whole point is
# that the content is PINNED. Measured on the owner's machine: 12 targets were
# older copies of these very skills, frozen at an upstream from months earlier,
# outside the pin the script advertises and managed by nobody.
#
# Park, never delete: the object moves with its inode intact into a reserved
# slot and can be moved back. This mirrors the park-always contract already
# implemented in install-codex-skills.sh and stated in AGENTS.md.
reserve_backup_slot() {
  local base="$1"
  local root skills
  local CDPATH=
  mkdir -p "$MATTPOCOCK_BACKUP_DIR"
  root="$(builtin cd -P -- "$MATTPOCOCK_BACKUP_DIR" && builtin pwd -P)" \
    || { echo "error: cannot resolve backup dir: $MATTPOCOCK_BACKUP_DIR" >&2; exit 1; }
  skills="$(builtin cd -P -- "$TARGET_SKILLS" && builtin pwd -P)" \
    || { echo "error: cannot resolve skills dir: $TARGET_SKILLS" >&2; exit 1; }
  # A backup root inside the skills tree would move an object from one
  # discoverable location to another — the agent would still load it, now under
  # a name nobody expects.
  case "$root/" in
    "$skills"/*)
      echo "error: refusing to write backups inside the skills tree: $root" >&2
      exit 1
      ;;
  esac
  mktemp -d "$root/$base.backup.$(date +%Y%m%d%H%M%S).XXXXXX"
}

# Moves the OBJECT, never rebuilds it: a symlink keeps its exact target string
# because the inode is preserved, and a rebuilt link would lose a trailing
# newline in the target invisibly. A parked symlink is stored as
# <base>.original so it resolves again once moved back. Sets PARKED_PATH.
park_target() {
  local target="$1"
  local base slot
  ensure_under "$target" "$TARGET_SKILLS"
  base="$(basename -- "$target")"
  slot="$(reserve_backup_slot "$base")"
  # An empty slot would make the mv below write to "/$base".
  [ -n "$slot" ] && [ -d "$slot" ] \
    || { echo "error: could not reserve a backup slot for $target" >&2; exit 1; }
  if [ -L "$target" ]; then
    PARKED_PATH="$slot/$base.original"
  else
    PARKED_PATH="$slot/$base"
  fi
  mv "$target" "$PARKED_PATH"
}

mkdir -p "$TARGET_SKILLS"

# --- Clone or update the cache (best-effort) -------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "warn: mattpocock skills skipped — git not found in PATH." >&2
  exit 0
fi

mkdir -p "$(dirname -- "$CACHE_DIR")"

# Check out MATTPOCOCK_REF, not whatever upstream HEAD happens to be.
#
# `git clone --depth 1` followed by `git pull --ff-only` meant every install
# could change what lands in a directory the agent reads, with no diff in this
# repo to review — and this particular upstream is documented as renaming
# skills without notice, so the content genuinely moves. Pinning turns that
# into a decision someone makes on purpose. It is also the precondition for
# active/contexts/mattpocock-skills.md ever being correct: a routing file
# cannot track a moving target.
#
# --depth 1 cannot check out an arbitrary SHA, so this fetches the ref instead
# of cloning at HEAD. GitHub serves a SHA to `fetch` directly; a server that
# refuses falls back to taking everything and resolving locally, which is also
# the path that makes a branch or tag name usable as MATTPOCOCK_REF.
checkout_pinned_ref() {
  if git -C "$CACHE_DIR" fetch --quiet --depth 1 origin "$MATTPOCOCK_REF" 2>/dev/null; then
    git -C "$CACHE_DIR" checkout --quiet --detach FETCH_HEAD || return 1
    return 0
  fi
  # --unshallow fails on an already-complete repo, so it is tried first and the
  # plain fetch covers that case.
  git -C "$CACHE_DIR" fetch --quiet --tags --unshallow origin 2>/dev/null \
    || git -C "$CACHE_DIR" fetch --quiet --tags origin 2>/dev/null \
    || return 1
  git -C "$CACHE_DIR" checkout --quiet --detach "$MATTPOCOCK_REF" || return 1
}

clone_ok=1
if [ ! -d "$CACHE_DIR/.git" ]; then
  if [ -e "$CACHE_DIR" ] || [ -L "$CACHE_DIR" ]; then
    ensure_under "$CACHE_DIR" "$(dirname -- "$CACHE_DIR")"
    rm -rf "$CACHE_DIR"
  fi
  git init --quiet "$CACHE_DIR" \
    || { echo "warn: mattpocock cache init failed; skipping install." >&2; clone_ok=0; }
  if [ "$clone_ok" = "1" ]; then
    git -C "$CACHE_DIR" remote add origin "$MATTPOCOCK_REPO" \
      || { echo "warn: mattpocock cache remote add failed; skipping install." >&2; clone_ok=0; }
  fi
fi

if [ "$clone_ok" = "1" ]; then
  # Force the configured origin so a MATTPOCOCK_REPO override always takes
  # effect even on an existing cache (otherwise the fetch would silently reuse
  # the old URL).
  git -C "$CACHE_DIR" remote set-url origin "$MATTPOCOCK_REPO" \
    || { echo "warn: mattpocock cache remote set-url failed." >&2; clone_ok=0; }
fi

if [ "$clone_ok" = "1" ]; then
  checkout_pinned_ref \
    || { echo "warn: mattpocock cache could not reach ref $MATTPOCOCK_REF (network/repo?); skipping install." >&2; clone_ok=0; }
fi

# Verify the checkout landed on the pin. Only meaningful when the ref is a full
# SHA — a branch or tag name resolves to a commit whose id is not the ref, and
# asserting equality there would refuse a legitimate override.
if [ "$clone_ok" = "1" ]; then
  case "$MATTPOCOCK_REF" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]\
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      landed="$(git -C "$CACHE_DIR" rev-parse HEAD 2>/dev/null || true)"
      if [ "$landed" != "$MATTPOCOCK_REF" ]; then
        echo "warn: mattpocock cache is at ${landed:-unknown}, not the pinned $MATTPOCOCK_REF; skipping install." >&2
        clone_ok=0
      fi
      ;;
  esac
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
parked_collision=0
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
          # A symlink we don't own: PARKED, not skipped. Never clobbered — the
          # link moves whole, target string intact, and comes back by moving it
          # back out of the slot.
          park_target "$target"
          echo "warn: parked '$name' — foreign symlink ($current) moved to $PARKED_PATH" >&2
          parked_collision=$((parked_collision + 1))
          ln -sfn "$source" "$target"
          installed=$((installed + 1))
          ;;
      esac
      continue
    fi

    # A real dir/file we did not create, or a dangling link (-e is false for a
    # dangling link, hence the -L): PARKED, not skipped. Skipping left the
    # target on an unmanaged copy while the run exited 0 claiming success.
    if [ -e "$target" ] || [ -L "$target" ]; then
      park_target "$target"
      echo "warn: parked '$name' — existing object moved to $PARKED_PATH" >&2
      parked_collision=$((parked_collision + 1))
    fi

    ensure_under "$target" "$TARGET_SKILLS"
    ln -sfn "$source" "$target"
    installed=$((installed + 1))
  done
done

echo "Installed $installed mattpocock skills into $TARGET_SKILLS"
echo "Skipped: caveman skill (caveman plugin owns it), deprecated/in-progress/personal categories."
if [ "$parked_collision" -gt 0 ]; then
  echo "Parked $parked_collision colliding object(s) into $MATTPOCOCK_BACKUP_DIR (see warns above); the managed links are installed."
fi
echo "Cache: $CACHE_DIR"
