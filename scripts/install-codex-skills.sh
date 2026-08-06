#!/usr/bin/env bash
set -euo pipefail

# --- INHERITED-STATE BOUNDARY ----------------------------------------------
# See scripts/bootstrap-codex.sh for the full four-category taxonomy and its
# Tier B acceptances (BASH_ENV/ENV, noexec, xtrace/PS4, PATH, function
# shadowing — an adversary who can set them already executes code as this user).
# Only what is LIVE IN THIS FILE is restated:
#   CDPATH      LIVE, fixed. `cd` with a BARE RELATIVE operand that selects a
#               NONEMPTY CDPATH entry PRINTS the directory it chose, and that
#               line lands inside the $( ) capture — two lines where the code
#               requires one. It bites when this script is invoked as
#               `bash scripts/install-codex-skills.sh`, because BASH_SOURCE is
#               then relative and dirname yields a bare "scripts". Neutralised
#               here and locally in every helper that runs `cd`.
#   noglob      LIVE, fixed by `set +f`. Inherited through SHELLOPTS it makes
#               globs literal, and this file's skill loop is a glob: `for source
#               in "$SOURCE_SKILLS"/*` would iterate the literal pattern, fail
#               `[ -d ]`, install ZERO skills and still report success.
#   GLOBIGNORE  NOT live across a process boundary; IFS is reset by bash at
#   IFS         startup. Both retained for the SOURCED case only.
# `umask 022` is deliberately NOT ported from the siblings: this file's
# trees_identical digest includes mode bits, so forcing a umask would perturb
# that comparison, and a permissions change is outside this containment port.
# ---------------------------------------------------------------------------
CDPATH=
GLOBIGNORE=
IFS=$' \t\n'
set +f          # noglob: inherited via SHELLOPTS, makes globs literal

# Exact capture: `$( )` strips EVERY trailing newline and both `pwd -P` and
# `dirname` terminate their output with one, so a checkout literally named
# "<name>"$'\n' collapses onto its newline-free sibling and this script would
# install from the WRONG TREE — every source below hangs off REPO_ROOT
# ($SOURCE_SKILLS, the promoted skills, the Impeccable agents link). The X
# sentinel gives $( ) something of its own to eat. Results land in globals on
# purpose: a second $( ) around a printing helper would re-eat the newline.
# Never `local x="$(cmd)"` — `local` always returns 0 and would swallow the
# status.
dirname_exact() {
  DIRNAME_EXACT="$(dirname -- "$1" && printf X)" || { DIRNAME_EXACT=""; return 1; }
  DIRNAME_EXACT="${DIRNAME_EXACT%X}"
  DIRNAME_EXACT="${DIRNAME_EXACT%$'\n'}"
  [ -n "$DIRNAME_EXACT" ]
}

physical_dir_exact() {
  # `local CDPATH=`: with CDPATH set, `cd` PRINTS the directory it chose and
  # that line lands inside the capture below.
  local CDPATH=
  PHYSICAL_DIR="$(builtin cd -P -- "$1" 2>/dev/null && builtin pwd -P && printf X)" || { PHYSICAL_DIR=""; return 1; }
  PHYSICAL_DIR="${PHYSICAL_DIR%X}"
  PHYSICAL_DIR="${PHYSICAL_DIR%$'\n'}"
  [ -n "$PHYSICAL_DIR" ]
}

dirname_exact "${BASH_SOURCE[0]}" \
  || { echo "error: cannot derive this script's directory." >&2; exit 1; }
physical_dir_exact "$DIRNAME_EXACT" \
  || { echo "error: cannot resolve this script's directory physically." >&2; exit 1; }
SCRIPT_DIR="$PHYSICAL_DIR"
# The `..` is resolved by `cd -P`, not lexically: a lexical strip would climb
# past a symlinked component and name a directory this script does not live in.
physical_dir_exact "$SCRIPT_DIR/.." \
  || { echo "error: cannot resolve the cortex checkout root." >&2; exit 1; }
REPO_ROOT="$PHYSICAL_DIR"
# Having made a newline in the checkout's name VISIBLE, refuse it: the
# exactness guarantee dies at the process boundary, and this script hands off to
# scripts/update-karpathy-skills.sh and gstack's own `./setup`, which re-derive
# their roots with bare $( ) captures. bootstrap-codex.sh already refuses this
# before delegating here; this is the guard for a DIRECT invocation, which is
# the documented way to run the installer on its own.
case "$REPO_ROOT" in
  *$'\n'*)
    echo "Refusing a cortex checkout whose path contains a newline: $REPO_ROOT" >&2
    exit 1
    ;;
esac
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SOURCE_SKILLS="$REPO_ROOT/codex/skills-local"
TARGET_SKILLS="$CODEX_HOME/skills"
GSTACK_REPO="${GSTACK_REPO:-https://github.com/garrytan/gstack.git}"
GSTACK_MIGRATED_DIR="${GSTACK_MIGRATED_DIR:-$HOME/.gstack/repos/gstack}"
GSTACK_BACKUP_DIR="${GSTACK_BACKUP_DIR:-$CODEX_HOME/backups/skills}"
INSTALL_GSTACK="${INSTALL_GSTACK:-1}"
INSTALL_KARPATHY="${INSTALL_KARPATHY:-1}"
PROMOTED_CORTEX_SKILLS="dead-code-audit impeccable jarvis-learn loop-hermes orchestrate security-audit strategic-compact verification-loop"
AGENTS_TARGET_SKILLS="${AGENTS_TARGET_SKILLS:-$HOME/.agents/skills}"

ensure_under() {
  # `local CDPATH=` plus `builtin cd -P`/`builtin pwd -P`: CDPATH would print
  # the directory it selected INTO these captures, and a LOGICAL cd/pwd reports
  # the pretty path, so a symlinked component would compare as if it were where
  # it is spelled rather than where it lands. Both operands are resolved the
  # same way, so an ordinary symlinked home still matches itself.
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

# --------------------------------------------------------------------------
# GUARANTEE, scoped precisely: in its own operations on target paths and on
# staging, this file deletes nothing it did not create in this run — there is
# not even the one owner-approved alias unlink that bootstrap-claude.sh
# carries. The scope excludes work delegated to other programs: `git pull
# --ff-only` on a pre-existing gstack checkout removes tracked files deleted
# upstream, and gstack's own `./setup` does whatever upstream decides. Those
# are other tools acting on their own trees, not this script on a target.
#
# Every terminal branch, enumerated from the code rather than from intent:
#   CREATE  — nothing was at the path: our copy or symlink is placed.
#   NO-OP   — the tree is already byte-for-byte what we would install (the
#             steady state), or the promoted/agents_target link is already
#             ours. Nothing is touched.
#   PARK    — anything else occupying a path we need: moved into a reserved
#             slot, inode intact, and our copy or link takes the freed path.
#             There is NO skip-and-leave-unlinked branch left in this file.
#             Two sites used to have one — a real file/dir on a promoted skill
#             name, and any non-matching object at agents_target — and both
#             contradicted the park-always contract in AGENTS.md while exiting
#             0 with the managed link absent. Every collision now parks,
#             whatever the object type (real file, real directory, foreign
#             symlink, dangling symlink) and whichever managed tree it is in;
#             backup_foreign_target takes the containment root as a parameter
#             precisely because agents_target is not under $TARGET_SKILLS.
#             (scripts/bootstrap-claude.sh's HM loop still skips; that file is
#             a separate contract surface and is not governed from here.)
#   FAILED  — a vendored skill lost all three placement retries: not counted,
#             named on stderr, and the script exits non-zero at the end.
#   ABORT   — a guard refused (ensure_under, backup-root check, unreserved
#             slot) or a cp/mv failed: set -e stops the run with the target
#             untouched.
#   WARN    — the optional externals (karpathy, gstack) run under `|| echo
#             warn` guards, and the gstack block is a subshell whose internal
#             `exit 1`s — including a refused backup slot or a failed `mv` of
#             the direct gstack directory — are caught by that guard. They
#             warn, touch no cortex target, do NOT set failed_skills, and the
#             run continues to "Codex skills install complete" and exit 0.
#             Only the skill loop's own FAILED state changes the exit code.
#
# There is no ownership proof, because proving ownership is what made deletion
# look safe. The digest below decides one thing — leave the tree alone
# (silent, idempotent) or park it and say so. A wrong digest costs a redundant
# backup or a skipped refresh, never data, in either direction.
#
# KNOWN LIMITATIONS — accepted, not oversights. All three need either a second
# installer running concurrently against the same CODEX_HOME or a backup root
# on another filesystem; neither occurs in this cortex's actual use, and every
# failure direction is abort-or-preserve, never data loss. Fixing them means
# retry/rollback machinery whose own failure modes are worse than the races.
#   1. backup_foreign_skill is not atomic against a concurrent installer: if
#      the other run moves the target first, `mv "$target" "$PARKED_PATH"`
#      fails and set -e aborts instead of retrying. Two installers racing on a
#      DIVERGENT pre-existing target therefore do not converge — one aborts.
#   2. `ln -s` after an absence check is a check-then-act: the loser of a race
#      gets EEXIST and aborts under set -e, even though the winner installed
#      the identical canonical link.
#   3. PARK preserves the inode only for a same-filesystem move. GSTACK_BACKUP_DIR
#      is configurable; point it at another filesystem and `mv` degrades to
#      copy-then-unlink, so the "inode intact, restore by moving it back"
#      property becomes "content intact" — hardlinks and inode identity are
#      not preserved there.

# Digest tooling. Without it every tree simply looks different, so it gets
# parked instead of left alone: noisier, never destructive.
if command -v shasum >/dev/null 2>&1; then
  HAVE_HASH=1
  hash_files_cmd=(shasum -a 256)
  hash_stream() { shasum -a 256 | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  HAVE_HASH=1
  hash_files_cmd=(sha256sum)
  hash_stream() { sha256sum | awk '{print $1}'; }
else
  HAVE_HASH=0
  hash_files_cmd=(false)
  hash_stream() { return 1; }
fi

# BSD (macOS) and GNU stat disagree on flags; neither dereferences by default,
# which is the property we need. Fields: name | type | mode bits | link target.
if stat -f '%N' . >/dev/null 2>&1; then
  stat_fmt_cmd=(stat -f '%N|%HT|%Lp|%Y')
  stat_root_cmd=(stat -f 'ROOT|%HT|%Lp')
else
  stat_fmt_cmd=(stat -c '%n|%F|%a|%N')
  stat_root_cmd=(stat -c 'ROOT|%F|%a')
fi

# Digest of a directory tree: the root directory's own type and mode, then
# every entry's relative path, type, mode bits and symlink target, plus the
# content hash of every regular file, in a stable order. The root record is
# what makes "every entry, mode for mode" true — `-mindepth 1` alone would
# skip a chmod on the skill directory itself and call the tree unchanged.
#
# Deliberately NOT `diff -rq`: diff follows symlinks (so a link and a
# regular file with the same bytes compare equal) and ignores permissions, so
# a tree that differs meaningfully can look identical to it. On error the exit
# STATUS is non-zero (pipefail) but the output is NOT necessarily empty — a
# producer that dies after emitting bytes still leaves a partial stream to
# digest — so callers must check the status, not the string.
tree_digest() {
  local dir="$1"
  [ "$HAVE_HASH" -eq 1 ] || return 1
  (
    cd -- "$dir" 2>/dev/null || exit 1
    # The root's OWN type and mode, which -mindepth 1 below skips. Emitted as a
    # fixed "." record so the digest does not depend on where the tree lives:
    # a chmod on the skill directory itself is a difference, its path is not.
    "${stat_root_cmd[@]}" . || exit 1
    find . -mindepth 1 -print0 | LC_ALL=C sort -z | xargs -0 "${stat_fmt_cmd[@]}" || exit 1
    find . -mindepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 "${hash_files_cmd[@]}" || exit 1
  ) | hash_stream
}

# Same tree, byte for byte and mode for mode? Compared against the freshly
# staged copy rather than the source, so a machine with a non-022 umask (where
# `cp -R` writes different mode bits than the source has) still recognises its
# own previous install and stays quiet.
trees_identical() {
  local a="$1"
  local b="$2"
  local da db
  { [ ! -L "$a" ] && [ -d "$a" ]; } || return 1
  # No `|| true`: a partial digest from a failed pipeline must not be compared.
  da="$(tree_digest "$a" 2>/dev/null)" || return 1
  db="$(tree_digest "$b" 2>/dev/null)" || return 1
  { [ -n "$da" ] && [ -n "$db" ]; } || return 1
  [ "$da" = "$db" ]
}

# Read a symlink's target EXACTLY into $LINK_RAW. NEVER call this inside $( ).
#
# `readlink` without -n appends a delimiter only when the value does not
# already end in one, so a link to "/AA" and a link to "/AA\n" print identical
# bytes; `readlink -n` (BSD and GNU both) suppresses it, and the X sentinel
# stops $( ) from eating a newline that belongs to the value.
#
# The value is ASSIGNED, not printed, and that is the whole point: a helper
# that printed it would be captured by callers in a SECOND $( ), which eats the
# trailing newline again and silently undoes the sentinel — measured at 66
# bytes for a 67-byte target.
#
# DIRECT CALLS ONLY. The result travels in a global, so a call inside $( ), a
# pipeline, or any other subshell assigns in a child that then exits, leaving
# the parent with an EARLIER link's target — which could compare equal to the
# wrong source, and a *successful* subshelled call would look like it worked
# while handing back the old value. Every caller clears BOTH $LINK_RAW and its
# own output variable immediately before calling, so the worst case is empty.
#
# Empty is conservative at both callers, and now identically so: nothing
# compares equal, so the entry is PARKED and the managed link installed in its
# place — in the promoted-skill loop and at agents_target alike. (A park
# failure under a concurrent installer aborts; see KNOWN LIMITATIONS above.)
# Conservative here means "a redundant backup", never "a lost object" and never
# "a missing link".
LINK_RAW=""
read_link_exact() {
  LINK_RAW="$(readlink -n -- "$1" && printf X)" || { LINK_RAW=""; return 1; }
  LINK_RAW="${LINK_RAW%X}"
}

# Physical path: `cd -P` + `pwd -P` resolve every symlinked component, so a
# backup root that is itself a symlink into skills/ cannot slip past the guard
# in reserve_backup_slot (logical `cd`/`pwd` would report the pretty path).
physical_path() {
  local CDPATH=   # see physical_dir_exact: CDPATH makes `cd` print its choice
  builtin cd -P -- "$1" 2>/dev/null && builtin pwd -P
}

# Reserve an exclusive destination BEFORE anything moves. `mktemp -d` makes
# same-second collisions impossible, and the guard keeps preserved trees out of
# the skills directory, where Codex would discover them as skills.
reserve_backup_slot() {
  local base="$1"
  local root skills agents
  mkdir -p "$GSTACK_BACKUP_DIR"
  root="$(physical_path "$GSTACK_BACKUP_DIR")" || { echo "Cannot resolve backup dir: $GSTACK_BACKUP_DIR" >&2; exit 1; }
  skills="$(physical_path "$TARGET_SKILLS")" || { echo "Cannot resolve skills dir: $TARGET_SKILLS" >&2; exit 1; }
  case "$root/" in
    "$skills"/*)
      echo "Refusing to write backups inside the skills tree: $root" >&2
      exit 1
      ;;
  esac
  # Same rule for the second managed tree. Objects are now parked OUT of
  # $AGENTS_TARGET_SKILLS too, so a backup root inside it would move an object
  # from a discoverable location to another discoverable location. Conditional
  # on the directory existing: it is created only by the agents block at the
  # very end, and the skill loop calls this long before that — an unconditional
  # physical_path here would abort every ordinary install.
  if [ -d "$AGENTS_TARGET_SKILLS" ]; then
    agents="$(physical_path "$AGENTS_TARGET_SKILLS")" || agents=""
    if [ -n "$agents" ]; then
      case "$root/" in
        "$agents"/*)
          echo "Refusing to write backups inside the agents skills tree: $root" >&2
          exit 1
          ;;
      esac
    fi
  fi
  mktemp -d "$root/$base.backup.$(date +%Y%m%d%H%M%S).XXXXXX"
}

# Park an entry by MOVING THE OBJECT ITSELF, never rebuilding it: a symlink
# keeps its exact target string because the inode is preserved. read_link_exact
# CAN read a target faithfully (that is what `readlink -n` plus the sentinel is
# for), so the reason to move rather than rebuild is not impossibility — it is
# that a move needs no reconstruction at all: one rename, no second write path,
# nothing that could disagree about the value. Plain `readlink` WOULD lose it:
# its output for /AA and for /AA<newline> is byte-identical while `stat -f %z`
# reports 3 vs 4, which is how a rebuilt link or a "raw value" sidecar goes
# wrong. A parked symlink is stored as <base>.original and resolves again once
# moved back. Sets PARKED_PATH.
park_entry() {
  local target="$1"
  local slot="$2"
  local base
  base="$(basename -- "$target")"
  if [ -L "$target" ]; then
    PARKED_PATH="$slot/$base.original"
  else
    PARKED_PATH="$slot/$base"
  fi
  mv "$target" "$PARKED_PATH"
}

# Park anything occupying a managed target, whichever tree that target lives
# in. The containment guard is a PARAMETER because the two managed trees are
# different: skills go under $TARGET_SKILLS, the Impeccable agents link under
# $AGENTS_TARGET_SKILLS. Passing $TARGET_SKILLS for the agents link would make
# ensure_under refuse and abort the whole run under set -e — the backup ROOT is
# shared ($GSTACK_BACKUP_DIR), the containment root is not.
backup_foreign_target() {
  local target="$1"
  local parent="$2"
  local base slot
  ensure_under "$target" "$parent"
  base="$(basename -- "$target")"
  slot="$(reserve_backup_slot "$base")"
  # Never park into an unreserved path: an empty $slot would make park_entry
  # write to "/$base".
  [ -n "$slot" ] && [ -d "$slot" ] || { echo "error: could not reserve a backup slot for $target" >&2; exit 1; }
  park_entry "$target" "$slot"
  echo "warn: $target is not the vendored skill; backed up to $PARKED_PATH" >&2
}

backup_foreign_skill() {
  backup_foreign_target "$1" "$TARGET_SKILLS"
}

# Rename the staged tree into place. `mv` into a directory that appeared
# between the check and the rename moves the tree INSIDE it and still exits 0,
# so two concurrent installers would leave a nested, corrupt skill and both
# report success. The staged basename carries this run's PID, so a nested
# result is unambiguous: undo it and report the name as taken, and the caller
# retries against the tree that won the race.
place_tree() {
  local staged="$1"
  local target="$2"
  local staged_base nested
  # Split from `local`, which always returns 0 and would swallow a basename
  # failure, leaving $nested as "$target/" — a path that always exists.
  staged_base="$(basename -- "$staged")" || return 1
  nested="$target/$staged_base"
  { [ ! -e "$target" ] && [ ! -L "$target" ]; } || return 1
  mv "$staged" "$target" 2>/dev/null || return 1
  if [ -e "$nested" ] || [ -L "$nested" ]; then
    mv "$nested" "$staged"
    return 1
  fi
  return 0
}

is_promoted_cortex_skill() {
  local name="$1"
  case " $PROMOTED_CORTEX_SKILLS " in
    *" $name "*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ ! -d "$SOURCE_SKILLS" ]; then
  echo "Missing exported skills directory: $SOURCE_SKILLS" >&2
  exit 1
fi

mkdir -p "$TARGET_SKILLS"

# Staging sits beside the skills dir, never inside it: a half-copied tree must
# not be discoverable as a skill. Our run dir goes away on exit; one left by a
# SIGKILL is reported below, not swept — a glob `rm -rf` over paths this run
# did not create is the hazard this design removed, and a leftover holds
# nothing but copies of vendored sources.
STAGING_PARENT="$CODEX_HOME/.cortex-staging"
mkdir -p "$STAGING_PARENT"
STAGING_ROOT="$(mktemp -d "$STAGING_PARENT/run.XXXXXX")"
# Only our own run dir. The parent is deliberately left behind even when empty:
# it may have existed before this run, and removing it would both break the
# invariant and race a concurrent install between its mkdir and its mktemp.
trap 'rm -rf "$STAGING_ROOT"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

count=0
failed_skills=0
for source in "$SOURCE_SKILLS"/*; do
  [ -d "$source" ] || continue
  name="$(basename -- "$source")"
  case "$name" in
    .system|gstack|codex-primary-runtime|napkin) continue ;;
  esac
  if is_promoted_cortex_skill "$name" && [ -d "$REPO_ROOT/active/skills/$name" ]; then
    continue
  fi

  target="$TARGET_SKILLS/$name"
  # PID-suffixed so a tree nested by a racing `mv` is unmistakable (place_tree).
  staged="$STAGING_ROOT/$name.$$"
  cp -R "$source" "$staged"
  # Per-skill outcome. `count` is what the summary line reports, so it may only
  # be incremented for a skill that is genuinely on disk — placed by us, or
  # already byte-identical. Counting an exhausted retry would report a skill as
  # installed when it is not, which is the false-success class this whole
  # session exists to remove.
  placed=0
  for attempt in 1 2 3; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      ensure_under "$target" "$TARGET_SKILLS"
      if trees_identical "$target" "$staged"; then
        # Already exactly what we would install: leave it untouched. This is
        # the whole steady state — no swap, no backup, nothing said.
        placed=1
        break
      fi
      # Anything else — a user-authored skill under one of these generic names
      # (review, qa, ship, learn, ...), an edited copy of ours, a symlink — is
      # parked, never removed.
      backup_foreign_skill "$target"
    fi
    if place_tree "$staged" "$target"; then
      placed=1
      break
    fi
  done
  # Either the rename consumed it, or it is our own copy from moments ago.
  rm -rf "$staged"
  if [ "$placed" -eq 1 ]; then
    count=$((count + 1))
  else
    echo "error: skill '$name' NOT installed: $target kept being recreated by another install (3 attempts)." >&2
    failed_skills=$((failed_skills + 1))
  fi
done

leftovers=0
for dir in "$STAGING_PARENT"/run.*; do
  { [ -d "$dir" ] && [ "$dir" != "$STAGING_ROOT" ]; } && leftovers=$((leftovers + 1))
done
if [ "$leftovers" -gt 0 ]; then
  echo "note: $leftovers staging dir(s) under $STAGING_PARENT left by interrupted or concurrent runs; safe to delete when no install is running." >&2
fi

echo "Installed $count local Codex skills into $TARGET_SKILLS"

# karpathy is an optional external marketplace, like gstack below: best-effort.
# A codex/python/upstream failure must WARN and continue, never abort before the
# promoted cortex skills are linked. set -e is active here (not an `||` LHS), so
# `cmd || { ...; }` makes it non-fatal without disabling set -e for the rest.
if [ "$INSTALL_KARPATHY" = "1" ] && [ -x "$SCRIPT_DIR/update-karpathy-skills.sh" ]; then
  "$SCRIPT_DIR/update-karpathy-skills.sh" \
    || echo "warn: karpathy install failed (optional, non-fatal); cortex skills still install below." >&2
fi

# gstack is an optional external framework. Its clone/setup is best-effort:
# a failed clone or a failing upstream ./setup must WARN and CONTINUE, never
# abort the install — the cortex's own promoted skills (linked below) must
# always provision. The whole block runs in a subshell so any non-zero exit is
# caught by the trailing guard without disabling set -e for the rest of the script.
if [ "$INSTALL_GSTACK" = "1" ]; then
  (
    if ! command -v git >/dev/null 2>&1; then
      echo "Skipping gstack: git not found in PATH."
      exit 0
    fi

    gstack_dir="$TARGET_SKILLS/gstack"
    gstack_setup_dir="$GSTACK_MIGRATED_DIR"
    # set -e is suspended inside this subshell (it is the LHS of `||`), so each
    # fallible git command must guard its own exit explicitly. On failure: warn
    # and exit the subshell so the trailing guard fires and we never fall through
    # to the bun check / "gstack cloned" message with a clone that did not happen.
    if [ -d "$GSTACK_MIGRATED_DIR/.git" ]; then
      git -C "$GSTACK_MIGRATED_DIR" pull --ff-only \
        || { echo "warn: gstack pull failed." >&2; exit 1; }
      if [ -d "$gstack_dir/.git" ] && [ "$gstack_dir" != "$GSTACK_MIGRATED_DIR" ]; then
        # Same reserved-slot rule as every other backup: exclusive destination,
        # guarded root. The old fixed name collided by the second and skipped
        # the "not inside skills/" check entirely.
        slot="$(reserve_backup_slot gstack.direct)" \
          || { echo "warn: could not reserve a gstack backup slot." >&2; exit 1; }
        mv "$gstack_dir" "$slot/gstack" \
          || { echo "warn: gstack direct backup (mv) failed." >&2; exit 1; }
        echo "Backed up direct gstack directory to $slot/gstack"
      fi
    elif [ -d "$gstack_dir/.git" ]; then
      gstack_setup_dir="$gstack_dir"
      git -C "$gstack_setup_dir" pull --ff-only \
        || { echo "warn: gstack pull failed." >&2; exit 1; }
    else
      mkdir -p "$(dirname -- "$GSTACK_MIGRATED_DIR")"
      git clone --depth 1 "$GSTACK_REPO" "$GSTACK_MIGRATED_DIR" \
        || { echo "warn: gstack clone failed." >&2; exit 1; }
    fi

    if command -v bun >/dev/null 2>&1; then
      (cd "$gstack_setup_dir" && ./setup --host codex --no-prefix)
    else
      echo "gstack cloned, but setup was skipped because bun is not installed."
      echo "Install bun, then run: cd $gstack_setup_dir && ./setup --host codex --no-prefix"
    fi
  ) || echo "warn: gstack install/setup failed (optional, non-fatal); cortex skills still install below. See output above." >&2
fi

promoted_count=0
for name in $PROMOTED_CORTEX_SKILLS; do
  source="$REPO_ROOT/active/skills/$name"
  [ -d "$source" ] || continue

  target="$TARGET_SKILLS/$name"
  if [ -L "$target" ]; then
    # The byte-for-byte read is what defeats a forged "<source>\n": it does not
    # compare equal, so it is parked instead of counted as ours. Such a twin
    # can exist and resolve (see the N2 fixture), so `-e` is not the guard
    # here — it is a separate, weaker one that catches dangling links.
    raw=""; LINK_RAW=""
    if read_link_exact "$target"; then raw="$LINK_RAW"; fi
    if [ -e "$target" ] && [ "$raw" = "$source" ]; then
      promoted_count=$((promoted_count + 1))
      continue
    fi
    # Foreign symlink (user's own, or ours from a moved cortex root): mv keeps
    # the link and whatever it points at, then we re-link so the install heals.
    backup_foreign_skill "$target"
  elif [ -e "$target" ]; then
    # Real file/dir we did not create. PARKED, not skipped. Skipping was a
    # contradiction of the park-always contract in AGENTS.md ("nome que colide
    # com um alvo gerenciado é PARQUEADO ... nunca deletado"), and the cost was
    # not theoretical: the run printed a warning, installed no link, and still
    # exited 0, so a promoted cortex skill was silently absent from Codex while
    # the summary line claimed a successful install. Parking preserves the
    # user's object with its inode intact AND provisions the managed link.
    backup_foreign_skill "$target"
  fi
  ln -s "$source" "$target"
  promoted_count=$((promoted_count + 1))
done

echo "Linked $promoted_count promoted cortex skills into $TARGET_SKILLS"

if [ -d "$REPO_ROOT/active/skills/impeccable" ]; then
  mkdir -p "$AGENTS_TARGET_SKILLS"
  agents_target="$AGENTS_TARGET_SKILLS/impeccable"
  agents_raw=""
  if [ -L "$agents_target" ] && [ -e "$agents_target" ]; then
    LINK_RAW=""
    if read_link_exact "$agents_target"; then agents_raw="$LINK_RAW"; fi
  fi
  # $agents_raw is empty unless the link resolves and was read byte-for-byte.
  if [ "$agents_raw" = "$REPO_ROOT/active/skills/impeccable" ]; then
    :
  else
    # Same park-always rule as every other managed target. This branch used to
    # warn and leave the object, which meant the agents-global Impeccable link
    # was never installed while the run still exited 0 — doctor.sh then reports
    # "Agents global Impeccable skill missing" on a run that claimed success.
    # ANY non-matching object is parked: real file, real directory, foreign
    # symlink, or dangling symlink (hence `-e` OR `-L`).
    if [ -e "$agents_target" ] || [ -L "$agents_target" ]; then
      backup_foreign_target "$agents_target" "$AGENTS_TARGET_SKILLS"
    fi
    ln -s "$REPO_ROOT/active/skills/impeccable" "$agents_target"
  fi
fi

# A skill that lost every retry is a failed install, not a quiet warning: the
# run must not claim completion and must not exit 0. Everything else above has
# already been provisioned, so this is the last statement rather than an early
# abort — a lost race on one skill does not block the other 93 or the links.
if [ "$failed_skills" -gt 0 ]; then
  echo "error: $failed_skills local Codex skill(s) were NOT installed (named above)." >&2
  exit 1
fi

echo "Codex skills install complete. Restart Codex to reload skills."
