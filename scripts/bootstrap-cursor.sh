#!/usr/bin/env bash
# scripts/bootstrap-cursor.sh — Wires the Jarvis cortex into Cursor IDE.
#
# Idempotent. Honors HOME / CURSOR_HOME. Derives cortex root from this script.
#
# What it does:
#   - links cursor/hooks/*.js → $CURSOR_HOME/hooks/
#   - merges jarvis-managed entries into $CURSOR_HOME/hooks.json
#   - links unrestricted Cursor permissions into $CURSOR_HOME/permissions.json
#   - merges jarvis-managed mcpServers into $CURSOR_HOME/mcp.json
#   - writes $CURSOR_HOME/rules/jarvis-cortex.mdc
#   - links a curated native skill set into $CURSOR_HOME/skills
#   - keeps Brain integration inside the managed Cursor MCP configuration
#
# Usage:
#   ./scripts/bootstrap-cursor.sh
#   CURSOR_HOME=/custom/.cursor ./scripts/bootstrap-cursor.sh
#   ./scripts/bootstrap-cursor.sh -h | --help

set -euo pipefail

# --- INHERITED-STATE BOUNDARY ----------------------------------------------
# Read this before adding another `command`/`builtin` prefix, another defensive
# assignment, or another "this is now closed" claim.
#
# FOUR categories of inherited state have been swept so far. Each sweep was
# complete WITHIN a boundary that silently excluded the next one:
#   1. external binaries      -> `command` prefixes
#   2. shell builtins         -> `builtin` prefixes
#   3. environment variables  -> CDPATH/GLOBIGNORE/IFS below
#   4. shell options + umask  -> `set +f` and `umask` below
# That progression is the most transferable thing this work produced: a sweep is
# only as good as its taxonomy, and the taxonomy deserves the same adversarial
# scrutiny as the findings. This block was itself written around three of them
# and was stale within a day. A boundary document written while the boundary is
# still being mapped goes stale immediately — which is an argument for stating
# what has been swept and leaving the enumeration explicitly OPEN, not for
# deferring the document until the map is finished. It never is.
#
# THIS IS THE CURRENT STATE OF KNOWLEDGE, NOT A CEILING. The plausible fifth
# category is process state this script also inherits and has never examined:
# open file descriptors, signal dispositions, `ulimit` values, and the starting
# working directory. Not chased, not claimed closed.
#
# --- TIER A: correctable in-script — FIXED ---------------------------------
# Every item here is an ordinary thing to find in a shell profile, not an
# attack, and every one is defensible from inside the script.
#   CDPATH      LIVE, fixed. When `cd` is given a BARE RELATIVE operand (not
#               starting with ./ or ../) and selects a NONEMPTY CDPATH entry, it
#               PRINTS the directory it chose — and that line lands INSIDE the
#               $( ) capture. An empty CDPATH, or an operand that no entry
#               matches, prints nothing; the bug needs all three conditions.
#               Measured: the capture became "./tmp\n/private/tmp" where the
#               code expects one line, corrupting the value the whole topology
#               gate is built on. The irony is exact — this discipline exists to
#               preserve a TRAILING newline, and CDPATH injects a LEADING line.
#               It bites when invoked as `bash scripts/bootstrap-*.sh`, because
#               BASH_SOURCE is then relative and dirname yields a bare
#               "scripts". Measured end to end: without the guard that
#               invocation dies with "cannot resolve the cortex checkout root".
#               Neutralised below AND locally in every helper that runs `cd`.
#   noglob      LIVE, fixed by `set +f`. Inherited through SHELLOPTS, it makes
#               globs literal: measured, `for d in .../*/` yielded the
#               unexpanded pattern, which would make this script derive a
#               managed target literally named `skills/*`.
#   umask       LIVE, fixed. `mkdir -p` applies the ambient umask, so under
#               `umask 000` managed directories are created world-writable —
#               measured 777. A mode you did not assert is a mode you inherited.
#               `umask 022` below, plus an explicit chmod on the backup root,
#               which also repairs a pre-existing permissive one.
#   GLOBIGNORE  NOT live across a process boundary: an exported GLOBIGNORE is
#               present in a child bash's environment but does NOT filter that
#               child's globs (verified). An earlier probe that appeared to drop
#               a skill had set it in the SAME shell as the glob. The assignment
#               below is retained for the sourced case only.
#   IFS         NOT live either: bash resets IFS to space/tab/newline at startup
#               regardless of the environment (verified). Retained for the
#               sourced case; the manifest readers additionally set it
#               per-command (`while IFS=$'\t' read -r`).
#   LC_ALL /    LIVE, fixed AT THE USE SITE rather than by forcing a locale.
#   LC_COLLATE  Bracket RANGES are locale-sensitive in Bash 3.2: `[0-9]` matches
#               the Arabic-Indic digit ١ under fa_IR.UTF-8 and ar_SA.UTF-8, and
#               `[A-Za-z]` matches é under en_US.UTF-8 (both measured). The
#               link-count and skill-name validations therefore spell out
#               explicit ASCII sets instead of ranges, which is locale-proof in
#               every locale tested. Forcing LC_ALL=C was rejected: it would be
#               exported into the delegate and the node tools and change their
#               message locale.
#   TMPDIR      unused: every mktemp call passes an explicit template, so the
#               default temp root is never consulted (verified).
#
# --- TIER B: pre-entry — ACCEPTED and named --------------------------------
# These act before, or outside, anything this script can assign. No in-script
# fix exists, and none is attempted.
#   BASH_ENV /  sourced BEFORE line 1 of a non-interactive script (verified):
#   ENV         arbitrary code execution that no assignment here can reach.
#   noexec      inherited through SHELLOPTS: measured, both bootstraps exit 0
#               having produced NO OUTPUT AT ALL and done nothing. A caller who
#               can set it can make this script silently no-op.
#   xtrace /    can dump the script's own execution, including paths, to stderr
#   PS4         and can execute a command substitution embedded in PS4.
#   PATH        required for legitimate discovery of codex/git/node; NODE_BIN is
#               separately required to be absolute.
#   function    shadowing. ACCIDENTAL shadowing is real and worth defending
#   shadowing   against: `cd() { builtin cd "$@" && ls; }` with `export -f cd`
#               is an ORDINARY BASHRC IDIOM and it propagates into a child
#               `bash script.sh` (verified). `cd`/`pwd` are essentially the only
#               members of that set — people wrap `cd`; nobody accidentally
#               defines `[`. That is why the prefixes exist and why the list
#               stops where it does. ADVERSARIAL shadowing is undefendable from
#               inside, and the regress is provable in three steps on 3.2.57:
#                 `cd` shimmed          -> `builtin cd` still resolves
#                 `builtin` shimmed too -> `command builtin cd` still resolves
#                 `command` shimmed too -> nothing left; every escape is a name
#               `printf`, `builtin`, `command`, `[`, `test`, `read`, `cd`,
#               `pwd`, `type`, `trap`, `echo` and `hash` are all definable as
#               functions AND importable via `export -f`. `--posix` does not
#               protect `cd` on 3.2. For accuracy: `command` DOES bypass a
#               same-named function for builtins too — `command cd`, `command
#               pwd` and `command type` all work; `builtin` is merely clearer.
#               The one exception is a SLASH-NAMED function: Bash 3.2 REJECTS
#               cross-process import of those, so the `type -t` check on
#               NODE_BIN guards the sourced and same-shell cases, not an
#               environment attack.
#
# THE HONEST BOUNDARY for every Tier B item: an adversary who can set them
# already executes code as the user. These bootstraps are not setuid and are not
# invoked by a privileged process, so no privilege boundary is crossed — such an
# attacker can simply run their own script instead. Accepted threat model.
#
# CONSIDERED AND REJECTED — do not spend a cycle rediscovering this. `bash -p`
# DOES block function import (plain `bash` reports `function` for an exported
# shim; `bash -p` reports NOT-IMPORTED). Not adopted: `#!/usr/bin/env bash`
# cannot carry `-p` portably, and a re-exec guard across the five bootstrap
# scripts costs more than this threat model justifies. Owner decision, at freeze.
# ---------------------------------------------------------------------------
CDPATH=
GLOBIGNORE=
IFS=$' \t\n'
set +f          # noglob: inherited via SHELLOPTS, makes globs literal
umask 022       # a mode you did not assert is a mode you inherited

# Resolve the checkout physically before deriving any managed source path.
# Invoking through ~/.codex/jarvis-cortex (often a symlink) must not leak the
# alias into the manifest or make the root guard compare two spellings of the
# same checkout.
#
# Both derivations go through the exact-capture helpers below rather than a
# bare $( ). $( ) strips EVERY trailing newline and both `pwd -P` and `dirname`
# terminate their output with one, so a checkout directory literally named
# "<name>"$'\n' collapses onto its newline-free sibling "<name>". REPO_ROOT
# would then name a DIFFERENT directory than the one this script lives in, and
# every containment decision below (SOURCE_ROOT, PROTECTED_TREES, MANAGED_TREES)
# would guard that sibling while the real checkout stayed open — as would the
# manifest destination derived from it.

# Exact capture, same discipline as read_link_exact in bootstrap-claude.sh:
# append an inert X sentinel so $( ) has something of its own to eat, strip it,
# then strip the ONE delimiter the command itself appended. Results land in
# globals on purpose — wrapping a call in a second $( ) would re-eat the
# newline, which is exactly the bug that was found and fixed in the sibling.
dirname_exact() {
  DIRNAME_EXACT="$(dirname -- "$1" && printf X)" || { DIRNAME_EXACT=""; return 1; }
  DIRNAME_EXACT="${DIRNAME_EXACT%X}"
  DIRNAME_EXACT="${DIRNAME_EXACT%$'\n'}"
  [ -n "$DIRNAME_EXACT" ]
}

physical_dir_exact() {
  # `local CDPATH=`: with CDPATH set, `cd` PRINTS the directory it chose and
  # that line lands inside the capture below. Belt and braces with the global
  # assignment in the ceiling block — this helper is the primitive the whole
  # topology gate rests on, and a port that copies it must carry the guard.
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
physical_dir_exact "$SCRIPT_DIR/.." \
  || { echo "error: cannot resolve the cortex checkout root." >&2; exit 1; }
REPO_ROOT="$PHYSICAL_DIR"
# Same REJECT as bootstrap-codex.sh, for the same reason: the exact capture makes
# a newline in the checkout's name VISIBLE instead of collapsing it onto a
# newline-free sibling, and the exactness guarantee then dies at every process
# boundary this script crosses. REPO_ROOT is handed to cursor-skill-manifest.mjs,
# cursor-root-guard.mjs and the rest of the .mjs delegates, and is written into
# the skill manifest. Refusing here is one check; auditing every callee's own
# root handling is not, and a callee that re-derives its root cannot be bound
# from this side.
case "$REPO_ROOT" in
  *$'\n'*)
    echo "Refusing a cortex checkout whose path contains a newline: $REPO_ROOT" >&2
    exit 1
    ;;
esac
HOME="${HOME:-$(eval echo "~$(id -un 2>/dev/null || echo root)")}"
CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
# `type -P`, never `command -v`: command -v returns the bare NAME when a shell
# function called `node` exists, and NODE_BIN would then hold "node" — which
# `[ -x "$NODE_BIN" ]` tests RELATIVE TO CWD, so an executable named `node` in
# the working directory passes the guard and replaces every Node-based check in
# this script. `type -P` searches PATH only, so it does not yield a function.
# Same shape as scripts/bootstrap-opencode.sh, which closed this first and
# established that `type -P` alone is not sufficient: NODE_BIN can also arrive
# from the environment already spelled as a bare name, so the absolute-path
# requirement below and the `command` prefix at every invocation site are both
# part of it. None of this is a trust boundary — `command` and `builtin` are
# themselves shadowable. See the SHADOWING CEILING at the top of this file.
NODE_BIN="${NODE_BIN:-$(type -P node 2>/dev/null || true)}"
GSTACK_REPO_ROOT="${GSTACK_REPO_ROOT:-$HOME/.gstack/repos/gstack}"
GSTACK_CURSOR_SKILLS="$GSTACK_REPO_ROOT/.cursor/skills"
CURSOR_MANIFEST_TOOL="${CURSOR_MANIFEST_TOOL:-$REPO_ROOT/scripts/cursor-skill-manifest.mjs}"
CURSOR_COPY_TOOL="${CURSOR_COPY_TOOL:-$REPO_ROOT/scripts/cursor-skill-copy.mjs}"
CURSOR_GSTACK_TOOL="${CURSOR_GSTACK_TOOL:-$REPO_ROOT/scripts/cursor-gstack-install.mjs}"
CURSOR_ROOT_GUARD="${CURSOR_ROOT_GUARD:-$REPO_ROOT/scripts/cursor-root-guard.mjs}"
CURSOR_LINK_TARGET_TOOL="${CURSOR_LINK_TARGET_TOOL:-$REPO_ROOT/scripts/cursor-link-target.mjs}"
CURSOR_STALE_LINK_GUARD="${CURSOR_STALE_LINK_GUARD:-$REPO_ROOT/scripts/cursor-stale-link-guard.mjs}"
CURSOR_LINK_OWNERSHIP_GUARD="${CURSOR_LINK_OWNERSHIP_GUARD:-$REPO_ROOT/scripts/cursor-link-ownership-guard.mjs}"
CURSOR_ANCHORED_FS="${CURSOR_ANCHORED_FS:-$REPO_ROOT/scripts/cursor-anchored-fs.mjs}"
CURSOR_SKILLS="$CURSOR_HOME/skills"
. "$REPO_ROOT/scripts/cursor-third-party.sh"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node executable not found; required to merge Cursor JSON configs." >&2
  exit 1
fi
# Absolute or nothing. `[ -x ]` on a bare name resolves against CWD, so without
# this an ambient NODE_BIN=node plus a ./node in the working directory would
# satisfy the check above.
case "$NODE_BIN" in
  /*) ;;
  *) echo "Refusing a non-absolute node executable: $NODE_BIN" >&2; exit 1 ;;
esac
# Absolute is NOT the same as "cannot be a function". Bash 3.2 accepts
# `function /abs/path { …; }` — verified: `type -t` reports `function` and the
# body runs, while only the POSIX `/abs/path()` form is rejected. Importing such
# a name needs `export -f` from a parent, which the documented `./script`
# invocation does not do, so this is not a live bypass — but it is a real
# capability, so reject it explicitly instead of resting on an impossibility
# that does not hold.
if [ "$(builtin type -t "$NODE_BIN" 2>/dev/null || true)" = "function" ]; then
  echo "Refusing a node executable shadowed by a shell function: $NODE_BIN" >&2
  exit 1
fi
# ERR-TRAP POLICY for the `command` prefix below — deliberate, do not normalise.
# `command X` fires the ERR trap in contexts where a bare `X` does not.
# Measured on bash 3.2.57 under `set -eE`, with the trap appending to a FILE:
#   if X            -> 0 hits | if command X            -> 1 hit
#   X || true       -> 0 hits | command X || true       -> 1 hit
#   fn{X} in `if`   -> 0 hits | fn{command X} in `if`   -> 1 hit
#   X="$( )"||true  -> 1 hit  | X="$(command …)"||true  -> 2 hits
# The trap must be recorded to a FILE, not a shell variable: the command in a
# $( ) runs in a SUBSHELL and cannot report its own trap back through a variable
# the parent reads. An earlier probe did exactly that and reported 0/0 for the
# last row, which is how six handled-failure sites were first missed.
# Note that row is 1 even bare — dropping `command` halves it, it cannot zero it.
#
# Row three is the subtle one: condition-context suppression does NOT reach a
# `command`-wrapped call inside a function body, so a boolean helper such as
# link_raw_target_is_exact or manifest_has_name fires ERR on its NORMAL false
# answer. Classification is therefore SEMANTIC — "is a non-zero exit expected
# here?" — not syntactic:
#   * handled-failure sites (if/elif conditions, `|| …`, `|| return $?`,
#     boolean predicate bodies) invoke "$NODE_BIN" DIRECTLY;
#   * unconditional sites keep `command`, where a firing trap is correct.
# The prefix is not what makes those sites safe: NODE_BIN is required to be
# absolute AND rejected if it names a shell function, both checked above — and
# none of those checks survive an adversarial environment either, per the
# SHADOWING CEILING at the top of this file.
# Neither script installs an ERR trap or `set -E` today, so this is latent, not
# live — it is closed so that adding one later cannot silently convert a
# non-fatal cleanup into an abort.

# --- shared link/backup policy -------------------------------------------
# Function bodies below are byte-identical to scripts/bootstrap-codex.sh and
# implement the same policy as scripts/bootstrap-claude.sh and
# scripts/install-codex-skills.sh. link_file has exactly three outcomes for
# whatever already occupies a target:
#   - a symlink already spelled exactly as this source, and resolving, is left
#     untouched — the idempotent re-run path, neither parked nor unlinked;
#   - a symlink proven to be a physical alias of this source is unlinked, under
#     the owner-approved exception documented at that branch;
#   - everything else that requires replacement is moved into a reserved slot,
#     and the new link takes its place.
# That alias branch is the only unlink link_file performs; other unlinks in this
# file belong to the ownership-verified skill reconciler further down. Ports must
# set BACKUP_ROOT, SOURCE_ROOT, PROTECTED_TREES and MANAGED_TREES, and must
# provide physical_dir_exact (defined above, outside the shared block because
# SCRIPT_DIR needs it before this point in the file).
#
# For the five fixed destinations wired below, cursor-root-guard.mjs has
# already rejected any symlink that does not realpath to its managed source,
# so the parking branches here are defense in depth rather than the gate.
#
# These are DEFINITIONS ONLY and deliberately sit above the first mutation: the
# gate that uses them has to run before cursor-root-guard.mjs creates anything.

# Physical path: `cd -P` + `pwd -P` resolve every symlinked component, so a
# component is resolved, which is what assert_managed_topology relies on to
# decide where a path really lands (logical `cd`/`pwd` would report the pretty
# path and hide a symlink into a protected tree).
physical_path() {
  local CDPATH=   # see physical_dir_exact: CDPATH makes `cd` print its choice
  builtin cd -P -- "$1" 2>/dev/null && builtin pwd -P
}

# Deepest EXISTING directory ancestor of $1, physically resolved, creating
# nothing. Result in ANCHOR_DIR (a global: a $( ) capture would eat a trailing
# newline of the value it is handing back).
#
# This is what lets a managed path that does not exist YET be judged on the
# location it will actually occupy. The old `[ -d "$path" ] || return 0` shape
# waved exactly that case through, so a caller pointing the managed home at a
# not-yet-existing descendant of a sensitive tree reached the first mutation
# with no containment check at all. A nonexistent path is inside an existing
# tree if and only if this anchor is: its missing components cannot already
# live inside that tree without their own parents existing first.
#
# `-d` FOLLOWS symlinks, which is the point — a symlink-to-directory parked at
# a managed ancestor is resolved here and judged where it really lands. A
# DANGLING symlink, or a symlink to a file, fails `-d`, so the walk strips it
# and anchors at its parent; that case is deliberately not covered by
# containment, and it is not a data-loss path either — `mkdir -p` fails on it
# and set -e aborts the run with nothing touched.
anchor_existing_dir() {
  local path="$1"
  local head
  ANCHOR_DIR=""
  case "$path" in
    /*) ;;
    *) return 1 ;;
  esac
  # A `..` component makes the invariant above FALSE, so it is refused outright
  # rather than walked. The walk is lexical; `..` is not. For a nonexistent
  # /x/missing/../repo/inside the walk climbs past the unresolvable middle to
  # /x, finds it outside the checkout, and APPROVES — then `mkdir -p` creates
  # `missing`, and from that instant the very same string resolves through `..`
  # straight back into the checkout. Measured before this guard existed: the
  # gate returned 0 and the entire managed home (AGENTS.md, skills, plugins,
  # active, scripts) was created inside the checkout. "Inside a tree iff the
  # anchor is" holds only for paths with no upward components.
  #
  # Refusing costs nothing real: every caller passes $X_HOME or a fixed child of
  # it, so a `..` can only arrive from a caller-supplied managed home, which has
  # a `..`-free spelling. Normalizing instead would mean re-deriving the path
  # through $( ) and re-opening the truncation hole this file just closed.
  case "$path" in
    */../*|*/..) return 1 ;;
  esac
  while [ ! -d "$path" ]; do
    head="${path%/*}"
    [ -n "$head" ] || head=/
    # The progress check comes BEFORE the assignment: a walk that cannot
    # shorten must not leave a half-advanced path behind for a caller that is
    # about to act on a failed precondition.
    [ "$head" != "$path" ] || return 1
    path="$head"
  done
  physical_dir_exact "$path" || return 1
  ANCHOR_DIR="$PHYSICAL_DIR"
}

# Compare where a link points physically, not how it is spelled: an aliased
# cortex root (~/.codex/jarvis-cortex), a duplicate slash, a dot or parent
# component. $3 is the exact raw value the caller already captured.
#
# Deliberately NOT `[ "$1" -ef "$2" ]`: -ef is inode equality, so bash 3.2 also
# calls two differently named hardlinks equal (`[ /bin/csh -ef /bin/tcsh ]` is
# true), which is not what "the same managed source" means. The caller must
# also have established that the link RESOLVES.
link_names_same_physical_file() {
  local target="$1"
  local source="$2"
  local raw="$3"
  local raw_dir raw_base source_dir source_base
  # Every dirname/basename/physical_path below goes through $( ), which eats
  # trailing newlines — so a newline anywhere in the three inputs would be
  # compared truncated. $raw was already covered; $target and $source were NOT,
  # and a truncated match here reaches the one branch in this file that deletes
  # (`rm -f "$target"`) without parking a backup first. No canonical spelling of
  # our own source contains a newline, so reject all three and let the caller
  # park instead. Concatenated because the test is "does any of them contain
  # one", not which.
  case "$raw$target$source" in
    *$'\n'*) return 1 ;;
  esac
  case "$raw" in
    /*) ;;
    *) raw="$(dirname -- "$target")/$raw" ;;
  esac
  raw_base="$(basename -- "$raw")" || return 1
  source_base="$(basename -- "$source")" || return 1
  [ "$raw_base" = "$source_base" ] || return 1
  raw_dir="$(physical_path "$(dirname -- "$raw")")" || return 1
  source_dir="$(physical_path "$(dirname -- "$source")")" || return 1
  [ "$raw_dir" = "$source_dir" ]
}

# Park an entry in an exclusive slot. `mktemp -d` reserves the destination
# before anything moves, so two backups in the same second cannot overwrite or
# nest inside each other, and the slot is never unlinked. It lives under
# BACKUP_ROOT, a fixed child of the managed home and therefore outside every
# discovery tree by construction, so a preserved skill or rule stops being
# discoverable content.
#
# The object itself is MOVED, never rebuilt: one rename(2) that either happens
# or does not. A symlink therefore keeps its exact target string and inode —
# a reconstructed link plus a "raw value" sidecar could disagree with the
# original and, worse, needed a delete to finish. A parked symlink is stored as
# <base>.original and resolves again once moved back where it came from.
# True when directory $1 is, or lives inside, directory $2 — by inode identity
# at every level. One fully-resolved directory walked upward; no traversal model,
# because both inputs here are fixed paths, not arbitrary user paths with "..".
# Identity rather than string prefix so an APFS firmlink spelling
# (/System/Volumes/Data/Users/... vs /Users/...) cannot slip past.
path_within_tree() {
  local CDPATH=   # see physical_dir_exact: CDPATH makes `cd` print its choice
  local node="$1"
  local tree="$2"
  local saved="$PWD"
  local prev result=1
  builtin cd -P -- "$node" 2>/dev/null || { builtin cd -P -- "$saved" 2>/dev/null || true; return 1; }
  while :; do
    if [ "$PWD" -ef "$tree" ]; then result=0; break; fi
    prev="$PWD"
    builtin cd -P .. 2>/dev/null || break
    [ "$PWD" != "$prev" ] || break
  done
  builtin cd -P -- "$saved" 2>/dev/null || true
  return "$result"
}

# One-shot topology check, run before anything is moved or linked.
#
# Hardcoding BACKUP_ROOT removed the untrusted *name* but not the untrusted
# *destination*: the managed home is still caller-supplied, so (a) a pre-existing
# `backups` symlink makes `mkdir -p` follow it into a protected tree, and (b) a
# home that overlaps the checkout ($X_HOME=$REPO_ROOT) makes a link's source and
# target the same file, so the first backup_target moves source code and leaves a
# self-referential link. Both are refused here, before the first mutation.
#
# Three distinct comparisons, deliberately not merged. The HOME is checked
# against $SOURCE_ROOT ONE WAY only — inside the checkout is refused, containing
# it is the documented layout and is allowed. The BACKUP ROOT is checked against
# every protected tree one-way. Every MANAGED TREE is checked against
# $SOURCE_ROOT in BOTH directions, which is where the reverse protection the
# home cannot provide actually lives.
#
# Nothing here returns early because a path does not exist yet. Every path is
# resolved through anchor_existing_dir, which reports where it WILL land, so a
# nonexistent managed home is judged on the location it is about to create
# rather than waved past the gate it was supposed to trip.
assert_managed_topology() {
  local home="$1"
  local backup_root="$2"
  local tree index managed home_anchor backup_anchor
  case "$home" in
    /*) ;;
    *) echo "Refusing a relative managed home: $home" >&2; exit 1 ;;
  esac
  anchor_existing_dir "$home" || {
    echo "Refusing a managed home that cannot be safely resolved (relative path, '..' component, or unreadable ancestor): $home" >&2
    exit 1
  }
  home_anchor="$ANCHOR_DIR"
  if [ -d "$SOURCE_ROOT" ]; then
    if path_within_tree "$home_anchor" "$SOURCE_ROOT"; then
      echo "Refusing a managed home inside the cortex checkout: $home" >&2
      exit 1
    fi
    # There is deliberately NO reverse test on the home. A home that CONTAINS
    # the checkout is the DOCUMENTED layout, not an attack: CLAUDE.md lists
    # ~/.codex/jarvis-cortex as a supported cortex root and instructs users to
    # clone there, which makes $CODEX_HOME=~/.codex an ancestor of the checkout.
    # The reverse test refused exactly that — measured: under the documented
    # arrangement every Codex bootstrap aborted with "Refusing a managed home
    # that contains the cortex checkout" and linked nothing.
    #
    # Containment belongs on the concrete DESTINATIONS instead, and that is
    # where it lives: every MANAGED_TREES entry carries its own reverse test
    # below. Those are specific paths that must never contain the checkout; the
    # home is a directory the checkout is explicitly allowed to live in.
    #
    # The forward test above still catches the dangerous case — a home INSIDE
    # the checkout, $CODEX_HOME == $REPO_ROOT included, because path_within_tree
    # matches at the first level.
    #
    # Do not "restore symmetry" here. Where a check refuses something the docs
    # instruct users to do, the check is wrong, not the docs.
  fi
  # Where the backup root will land, resolved WITHOUT creating it: an existing
  # entry (a pre-existing `backups` symlink included) resolves as it stands,
  # otherwise the deepest existing ancestor stands in for where mkdir -p would
  # put it.
  anchor_existing_dir "$backup_root" || {
    echo "Refusing a backup root that cannot be safely resolved (relative path, '..' component, or unreadable ancestor): $backup_root" >&2
    exit 1
  }
  backup_anchor="$ANCHOR_DIR"
  for ((index=1; index<${#PROTECTED_TREES[@]}; index++)); do
    tree="${PROTECTED_TREES[$index]}"
    [ -n "$tree" ] && [ -d "$tree" ] || continue
    if path_within_tree "$backup_anchor" "$tree"; then
      echo "Refusing a backup root that resolves inside $tree: $backup_root" >&2
      exit 1
    fi
  done
  # Managed link-target ancestors. These are the directories link_file creates
  # and then parks entries inside, so one of them redirected into the checkout
  # turns the next backup_target into a move of source code. Checked one-way:
  # a managed directory may never resolve inside $SOURCE_ROOT.
  if [ -d "$SOURCE_ROOT" ]; then
    for ((index=1; index<${#MANAGED_TREES[@]}; index++)); do
      managed="${MANAGED_TREES[$index]}"
      [ -n "$managed" ] || continue
      anchor_existing_dir "$managed" || {
        echo "Refusing a managed directory that cannot be safely resolved (relative path, '..' component, or unreadable ancestor): $managed" >&2
        exit 1
      }
      if path_within_tree "$ANCHOR_DIR" "$SOURCE_ROOT"; then
        echo "Refusing a managed directory that resolves inside the cortex checkout: $managed" >&2
        exit 1
      fi
      # REVERSE containment. The forward test alone is not enough: a managed
      # directory that CONTAINS the checkout passes it, and for
      # GSTACK_MIGRATED_DIR the delegate then runs `git -C … pull --ff-only`
      # over a tree holding the cortex. The home deliberately does NOT get this
      # test — a home containing the checkout is the documented layout — which is
      # exactly why the concrete destinations have to carry it.
      #
      # Same asymmetry as the home, for the same reason: this test uses the
      # directory ITSELF, never its anchor. A not-yet-existing managed directory
      # anchors at an ancestor that legitimately contains the checkout (~/ holds
      # both), so anchoring this direction would refuse ordinary bootstraps.
      # Only a directory that really exists can really contain the checkout.
      if [ -d "$managed" ] && path_within_tree "$SOURCE_ROOT" "$managed"; then
        echo "Refusing a managed directory that contains the cortex checkout: $managed" >&2
        exit 1
      fi
    done
  fi
}
# Pre-mutation counterpart to the check inside link_file's directory branch.
# MANAGED_TREES holds DIRECTORIES; the link targets themselves are leaf FILES
# and were never gated. A checkout at or below $X_HOME/AGENTS.md passed every
# topology check, and link_file's `elif [ -d "$target" ]` branch then moved it.
#
# The broad reverse test on the managed home had been masking this incidentally.
# Removing that test was correct — it refused the documented layout — but an
# over-broad guard hides whatever it covers, so the exposed set has to be
# enumerated deliberately rather than assumed empty. MANAGED_LEAVES is that
# enumeration; ports must define it.
#
# SYMLINKS ARE EXCLUDED, deliberately: a symlink at one of these paths must
# still be PARKED by link_file, not refused here. Park-always outranks this
# check, which exists only for real directories that cannot be parked safely.
assert_managed_leaves() {
  local leaf index
  [ -d "$SOURCE_ROOT" ] || return 0
  for ((index=1; index<${#MANAGED_LEAVES[@]}; index++)); do
    leaf="${MANAGED_LEAVES[$index]}"
    if [ -z "$leaf" ]; then continue; fi
    if [ -L "$leaf" ]; then continue; fi
    if [ ! -d "$leaf" ]; then continue; fi
    # One direction only. "Checkout is AT the leaf" and "checkout is BELOW the
    # leaf" are both this test, because path_within_tree matches at the first
    # level. The opposite direction — leaf inside the checkout — needs the home
    # to be inside the checkout, which the forward home test already refuses.
    if path_within_tree "$SOURCE_ROOT" "$leaf"; then
      echo "Refusing a managed leaf destination that is, or holds, the cortex checkout: $leaf" >&2
      exit 1
    fi
  done
}
backup_target() {
  local target="$1"
  local kind="$2"
  local base slot parked
  base="${target##*/}"
  mkdir -p "$BACKUP_ROOT"
  # ASSERT the mode; do not inherit it. `mkdir -p` applies the ambient umask, so
  # under `umask 000` this parking destination is created world-writable and any
  # local user can replace a parked entry, or win a race against the mv below.
  # The umask 022 set at the top of this file covers a root created HERE; this
  # chmod also fixes a root that already existed with a permissive mode.
  # Backups hold whatever we displaced from the managed home — often the user's
  # own config — so group/other write is never correct on it.
  chmod go-w "$BACKUP_ROOT" 2>/dev/null || true
  # $BACKUP_ROOT is used directly: assert_managed_topology proved its
  # destination at startup, and a $(physical_path ...) capture here would
  # truncate a trailing newline.
  slot="$(mktemp -d "$BACKUP_ROOT/$base.backup.$(date +%Y%m%d%H%M%S).XXXXXX")"
  # Never park into an unreserved path: an empty $slot would target "/$base".
  [ -n "$slot" ] && [ -d "$slot" ] || { echo "error: could not reserve a backup slot for $target" >&2; exit 1; }
  if [ -L "$target" ]; then
    parked="$slot/$base.original"
  else
    parked="$slot/$base"
  fi
  mv "$target" "$parked"
  echo "Backed up existing $target ($kind) to $parked"
}

link_file() {
  local source="$1"
  local target="$2"
  local target_dir raw
  # Parameter expansion, not $(dirname): $( ) eats a trailing newline, and these
  # targets are always absolute and never end in a slash, which is the only case
  # where the two spellings differ.
  target_dir="${target%/*}"
  [ -n "$target_dir" ] || target_dir=/
  mkdir -p "$target_dir"

  # -L is tested BEFORE -e: -e follows the link, so a symlink must be
  # classified here or it falls into the regular-file/dir branches below.
  if [ -L "$target" ]; then
    # Read the link EXACTLY. Plain `readlink` appends a delimiter only when the
    # value does not already end in one, so a link to "/AA" and a link to
    # "/AA\n" print identical bytes; `readlink -n` (BSD and GNU both) suppresses
    # it. The X sentinel then stops $( ) from eating a newline that belongs to
    # the value, and `&& printf X` keeps readlink's own exit status, because on
    # failure printf never runs. Captured inline: routing this through a helper
    # would put a second $( ) in the path and re-truncate the value.
    raw="$(readlink -n -- "$target" && printf X)" || {
      echo "error: cannot read symlink $target; refusing to touch it." >&2
      return 1
    }
    raw="${raw%X}"
    # Every branch that does not park also requires the link to RESOLVE, so a
    # link that merely looks like ours but points nowhere is preserved instead
    # of trusted. The `readlink -n` + sentinel capture above read the value
    # byte-for-byte, so the comparison is exact as well: a forged "<source>\n"
    # fails both tests and is parked even when such a file really does exist.
    if [ -e "$target" ] && [ "$raw" = "$source" ]; then
      return 0  # already our own link — idempotent no-op, the common re-run path
    fi
    if [ -e "$target" ] && link_names_same_physical_file "$target" "$source" "$raw"; then
      # Our own source under a different spelling (this cortex reached through
      # ~/.codex/jarvis-cortex, say). The link is an alias for the file we are
      # about to link: re-point it and stay silent rather than banking a backup
      # of our own file on every alternate run.
      #
      # ACCEPTED RISK — owner-approved, decided, not open. Do not "fix" this.
      # The check above and the unlink below are not atomic. Exploiting that
      # requires swapping $target inside the managed home between the two,
      # during a bootstrap — and anyone who can do that already has write
      # access to the whole tree. Removing the fast path instead would bank a
      # backup on every alternation between the two documented cortex spellings
      # (~/.codex/jarvis-cortex and the physical checkout), on the owner's own
      # machine. The owner took the race over the churn, deliberately.
      #
      # An atomic replacement was tried and rejected on evidence: staging a
      # link and `mv -f`-ing it over the target follows a symlink-to-DIRECTORY
      # on BSD. Verified — the staged link was moved INSIDE the source
      # directory, the alias was left unrepointed, and mv still returned 0.
      # bootstrap-codex.sh drives this primitive over exactly such targets (the
      # caveman agent-skill DIRECTORIES), which is where it broke; every
      # link_file target in bootstrap-cursor.sh is a file, which is why the
      # failure stayed invisible there. Both copies carry the same warning
      # because both call the same helper.
      rm -f "$target"
    else
      backup_target "$target" "symlink -> $raw"
    fi
  elif [ -d "$target" ]; then
    # backup_target is about to MOVE this directory. If it is, or contains, the
    # cortex checkout, that move relocates our own source tree — the same
    # destruction shape as C3, reached through a link TARGET instead of a
    # managed ancestor. MANAGED_TREES cannot cover this: these targets are leaf
    # FILES, and some (the agent-skill directories) are discovered from a glob,
    # so they cannot be enumerated before the loop runs.
    #
    # Only reachable when $target is NOT a symlink — a symlink took the -L
    # branch above — so park-always for symlinks is untouched by this check.
    # Cost is zero on the normal path: a leaf that is a directory is already the
    # rare case.
    if [ -d "$SOURCE_ROOT" ] && path_within_tree "$SOURCE_ROOT" "$target"; then
      echo "Refusing to park a directory that is, or holds, the cortex checkout: $target" >&2
      exit 1
    fi
    backup_target "$target" "directory"
  elif [ -e "$target" ]; then
    backup_target "$target" "file"
  fi

  ln -s "$source" "$target"
}

# FULL topology gate, before the first filesystem mutation.
#
# This replaces a partial overlap pre-check that opened with
# `[ -d "$CURSOR_HOME" ] || return 0`. That early return was the bypass: a
# CURSOR_HOME that did not exist yet was waved straight past it, and execution
# then reached cursor-root-guard.mjs — which CREATES managed directories —
# before the full gate had ever run. Pointing CURSOR_HOME at a not-yet-existing
# descendant of the checkout was therefore unchecked at the only moment it
# mattered. assert_managed_topology resolves a nonexistent path to the location
# it will actually occupy, so there is nothing left to wave through and no
# reason to keep a weaker subset check.
#
# The logical $CURSOR_HOME spellings are correct inputs here: the guard has not
# run yet, and every value below is re-derived from the guard's PHYSICAL paths
# and re-gated further down.
BACKUP_ROOT="$CURSOR_HOME/backups"
SOURCE_ROOT="$REPO_ROOT"
# Bash 3.2 + `set -u`: slot zero is inert so the indexed loop is nounset-safe.
PROTECTED_TREES=("" "$REPO_ROOT" "$CURSOR_SKILLS" "$CURSOR_HOME/rules")
# Ancestors of every managed link target. PROTECTED_TREES only ever covered the
# backup DESTINATION, which does not see this: link_file `mkdir -p`s each of
# these and then parks whatever occupies a leaf inside them. A pre-existing
# symlink at one of them pointing into the checkout passes every other check,
# and link_file's `elif [ -d "$target" ]` branch then MOVES the source directory
# into backups and leaves a self-referential link in its place. $CURSOR_HOME
# itself is deliberately absent. The home gets a ONE-WAY check only — inside the
# checkout is refused, CONTAINING it is the documented layout and is allowed —
# so this list owns the DESCENDANTS and each entry carries its own reverse test.
# Every link_file TARGET plus the two node-merged config leaves under the
# managed home. These are leaf FILES, so MANAGED_TREES cannot express them;
# assert_managed_leaves gates them before the first mutation. The per-hook and
# per-skill targets live under gated directories and are additionally covered by
# link_file's own directory-branch check.
MANAGED_LEAVES=("" "$CURSOR_HOME/permissions.json" "$CURSOR_HOME/hooks.json" \
  "$CURSOR_HOME/mcp.json" "$CURSOR_HOME/rules/jarvis-cortex.mdc")
MANAGED_TREES=("" "$CURSOR_SKILLS" "$CURSOR_HOME/rules" "$CURSOR_HOME/hooks" \
  "$CURSOR_HOME/jarvis-runtime" "$BACKUP_ROOT")
assert_managed_topology "$CURSOR_HOME" "$BACKUP_ROOT"
assert_managed_leaves

# Manifest generation is read-only and completes before the guard is allowed to
# create anything. The exact same snapshot is installed later in this run.
DESIRED_SKILL_PLAN="$(command "$NODE_BIN" "$CURSOR_MANIFEST_TOOL" "$REPO_ROOT" "$GSTACK_REPO_ROOT")"
if [ -z "$DESIRED_SKILL_PLAN" ]; then
  echo "Cursor native skill manifest is empty; refusing to mutate CURSOR_HOME." >&2
  exit 1
fi
GSTACK_PLAN_PRESENT="$(command "$NODE_BIN" -e '
  process.stdout.write(process.argv[1].split(/\n/)
    .some((line) => line.split("\t")[3] === "gstack") ? "yes" : "no");
' "$DESIRED_SKILL_PLAN")"
if [ "$GSTACK_PLAN_PRESENT" = "yes" ]; then
  BUN_BIN="$(command -v bun 2>/dev/null || true)"
  if [ -z "$BUN_BIN" ] || [ ! -f "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
    echo "Bun executable is required on PATH for Cursor gstack skills." >&2
    exit 1
  fi
fi

# This is the first filesystem mutation. The guard preflights every directory
# and fixed file destination before safely creating the managed directories.
PUBLIC_CURSOR_HOME="$CURSOR_HOME"
# Exact capture again: the guard terminates its answer with a newline, so a
# plain $( ) would collapse a managed skills path whose own name ends in one and
# aim CURSOR_HOME_PHYSICAL — and therefore the manifest writes below — at the
# wrong directory. `&& printf X` keeps the pipeline's exit status, because on
# failure printf never runs and set -e still fires on the assignment.
CURSOR_SKILLS="$(printf '%s\n' "$DESIRED_SKILL_PLAN" \
  | command "$NODE_BIN" "$CURSOR_ROOT_GUARD" ensure \
    "$CURSOR_HOME" "$HOME" "$REPO_ROOT" "$GSTACK_REPO_ROOT" && printf X)"
CURSOR_SKILLS="${CURSOR_SKILLS%X}"
CURSOR_SKILLS="${CURSOR_SKILLS%$'\n'}"
# Parameter expansion, not $(dirname): a second $( ) would re-eat the newline
# the capture above just went to the trouble of preserving.
CURSOR_HOME_PHYSICAL="${CURSOR_SKILLS%/*}"
[ -n "$CURSOR_HOME_PHYSICAL" ] || CURSOR_HOME_PHYSICAL=/
CURSOR_HOME_ANCHOR="$(command "$NODE_BIN" "$CURSOR_ANCHORED_FS" anchor "$CURSOR_HOME_PHYSICAL")"
CURSOR_SKILLS_ANCHOR="$(command "$NODE_BIN" "$CURSOR_ANCHORED_FS" anchor "$CURSOR_SKILLS")"

# Slots are reserved under BACKUP_ROOT, never beside the entry being preserved.
# Not overridable. There is no env knob for this path, so there is no untrusted
# input to validate: the backup root is always a fixed child of $CURSOR_HOME, and
# relocating $CURSOR_HOME (as every test fixture does) relocates the backups with
# it. Five rounds of validator hardening died here; the capability was the bug.
BACKUP_ROOT="$CURSOR_HOME/backups"
SOURCE_ROOT="$REPO_ROOT"
# Re-derived on the guard's PHYSICAL $CURSOR_SKILLS, which the pre-mutation gate
# above could only approximate with the logical spelling.
# Bash 3.2 + `set -u`: slot zero is inert so the indexed loop is nounset-safe.
PROTECTED_TREES=("" "$REPO_ROOT" "$CURSOR_SKILLS" "$CURSOR_HOME/rules")
# Every link_file TARGET plus the two node-merged config leaves under the
# managed home. These are leaf FILES, so MANAGED_TREES cannot express them;
# assert_managed_leaves gates them before the first mutation. The per-hook and
# per-skill targets live under gated directories and are additionally covered by
# link_file's own directory-branch check.
MANAGED_LEAVES=("" "$CURSOR_HOME/permissions.json" "$CURSOR_HOME/hooks.json" \
  "$CURSOR_HOME/mcp.json" "$CURSOR_HOME/rules/jarvis-cortex.mdc")
MANAGED_TREES=("" "$CURSOR_SKILLS" "$CURSOR_HOME/rules" "$CURSOR_HOME/hooks" \
  "$CURSOR_HOME/jarvis-runtime" "$BACKUP_ROOT")

# Second pass of the same gate, now that the root guard has resolved
# $CURSOR_SKILLS physically. The FIRST pass, above cursor-root-guard.mjs, is the
# one that actually protects the checkout — this one re-checks the resolved
# values and catches anything the guard's own creation step changed underfoot.
assert_managed_topology "$CURSOR_HOME" "$BACKUP_ROOT"
assert_managed_leaves

link_raw_target_is_exact() {
  local target="$1" source="$2"
  "$NODE_BIN" "$CURSOR_LINK_TARGET_TOOL" verify "$target" "$source"
}

link_targets_source_exactly() {
  local CDPATH=   # see physical_dir_exact: a selected CDPATH entry prints
  local target="$1" source="$2" source_path target_real source_real
  # Reject a newline BEFORE capturing, rather than proving the value cannot
  # contain one. The earlier proof ("$source comes from the manifest, which
  # rejects newline rows") held only for the manifest-driven callers. Four of
  # the six call paths in this file pass an ENV-DERIVED source that never goes
  # near the manifest filter: is_exact_generated_gstack_link and
  # is_legacy_gstack_copy_link both pass "$GSTACK_CURSOR_SKILLS/$name", and the
  # legacy migration loop passes "$GSTACK_REPO_ROOT" directly. $( ) would eat
  # the trailing newline, so a sibling WITHOUT one would be authenticated as
  # this source — and this function gates an `unlink`, so that is park-always
  # violated. Rejecting needs no proof about what the value can contain.
  case "$target$source" in
    *$'\n'*) return 1 ;;
  esac
  # `|| return 1`, not a bare capture: a non-zero exit from node must FAIL the
  # comparison. Swallowing it would leave source_path empty and hand an empty
  # string to the raw-exact check below.
  source_path="$("$NODE_BIN" -e 'const path=require("path"); process.stdout.write(path.resolve(process.argv[1]));' "$source")" \
    || return 1

  # Ownership is raw-string exact first. Normalizing readlink output would let
  # aliases, duplicate separators, and dot components impersonate this source.
  link_raw_target_is_exact "$target" "$source_path" || return 1

  # Then require the direct target and registered source to resolve to the
  # same physical tree. Dangling or retargeted links are never claimed.
  target_real="$(builtin cd "$target" 2>/dev/null && builtin pwd -P || true)"
  source_real="$(builtin cd "$source_path" 2>/dev/null && builtin pwd -P || true)"
  [ -n "$target_real" ] && [ -n "$source_real" ] && [ "$target_real" = "$source_real" ]
}

is_exact_generated_gstack_link() {
  local CDPATH=   # see physical_dir_exact: a selected CDPATH entry prints
  local target="$1" expected_source="$2" expected_parent_real generated_root_real
  if [ -e "$expected_source" ]; then
    link_targets_source_exactly "$target" "$expected_source"
    return
  fi

  # Pre-manifest installers could leave an exact dangling generated leaf after
  # a gstack update removed that skill. Its raw target plus the canonical,
  # existing generated parent still prove the narrow legacy cleanup boundary.
  link_raw_target_is_exact "$target" "$expected_source" || return 1
  expected_parent_real="$(builtin cd "$(dirname "$expected_source")" 2>/dev/null && builtin pwd -P || true)"
  generated_root_real="$(builtin cd "$GSTACK_CURSOR_SKILLS" 2>/dev/null && builtin pwd -P || true)"
  [ -n "$expected_parent_real" ] && [ "$expected_parent_real" = "$generated_root_real" ]
}

is_managed_skill_link() {
  local target="$1" expected_source="$2" previous_source="$3" name="$4" mode="$5" provenance="$6"
  local previous_mode="$7" previous_provenance="$8"
  link_targets_source_exactly "$target" "$expected_source" && return 0
  [ -n "$previous_source" ] && [ -n "$previous_mode" ] && [ -n "$previous_provenance" ] || return 1
  "$NODE_BIN" "$CURSOR_LINK_OWNERSHIP_GUARD" verify \
    "$REPO_ROOT" "$GSTACK_REPO_ROOT" "$name" \
    "$previous_source" "$previous_mode" "$previous_provenance" "$target" \
    "$expected_source" "$mode" "$provenance" >/dev/null 2>&1
}

is_legacy_cursor_copy_link() {
  local target="$1" name="$2" provenance="$3" previous_mode="$4" previous_provenance="$5"
  # A manifest row with a different mode cannot authorize a mode transition:
  # it may have been injected specifically to make a user symlink look stale.
  [ "${HAD_MANAGED_MANIFEST:-1}" -eq 0 ] || return 1
  [ -z "$previous_mode" ] && [ -z "$previous_provenance" ] || return 1
  [ "$name" = "impeccable" ] && [ "$provenance" = "cortex" ] || return 1
  link_targets_source_exactly "$target" "$REPO_ROOT/active/claude-skills/impeccable"
}

is_legacy_gstack_copy_link() {
  local target="$1" name="$2" provenance="$3" previous_mode="$4" previous_provenance="$5"
  # Only the pre-manifest generated layout is eligible for one-time migration.
  # Any recorded link mode must first match the canonical catalog, which
  # gstack-copy entries intentionally do not.
  [ "${HAD_MANAGED_MANIFEST:-1}" -eq 0 ] || return 1
  [ -z "$previous_mode" ] && [ -z "$previous_provenance" ] || return 1
  [ "$provenance" = "gstack" ] || return 1
  link_targets_source_exactly "$target" "$GSTACK_CURSOR_SKILLS/$name"
}

link_skill() {
  local source="$1"
  local target="$2"
  local previous_source="$3"
  local name="$4"
  local mode="$5"
  local provenance="$6"
  local previous_mode="$7"
  local previous_provenance="$8"
  # Same discipline as link_file: parameter expansion, not $(dirname). Targets
  # here are absolute and never end in a slash, the only case where they differ.
  local target_dir="${target%/*}"
  [ -n "$target_dir" ] || target_dir=/
  mkdir -p "$target_dir"

  if [ -L "$target" ]; then
    if link_targets_source_exactly "$target" "$source"; then
      return 0
    fi
    if is_managed_skill_link \
      "$target" "$source" "$previous_source" "$name" "$mode" "$provenance" \
      "$previous_mode" "$previous_provenance"; then
      unlink "$target"
    else
      echo "warn: $target exists and is not a Jarvis-managed symlink; preserving it." >&2
      return 10
    fi
  elif [ -e "$target" ]; then
    echo "warn: $target exists and is not a Jarvis-managed skill; preserving it." >&2
    return 10
  fi

  ln -s "$source" "$target"
}

copy_skill() {
  local source="$1" target="$2" previous_source="$3" name="$4" provenance="$5"
  local previous_mode="$6" previous_provenance="$7"
  if [ -L "$target" ]; then
    if is_legacy_cursor_copy_link \
      "$target" "$name" "$provenance" "$previous_mode" "$previous_provenance"; then
      unlink "$target"
    else
      echo "warn: $target exists and is not a Jarvis-managed symlink; preserving it." >&2
      return 10
    fi
  elif [ -e "$target" ]; then
    if [ "${HAD_MANAGED_MANIFEST:-1}" -eq 1 ] \
      && { [ "$previous_mode" != "cursor-copy" ] || [ "$previous_provenance" != "$provenance" ]; }; then
      echo "warn: $target is not backed by the exact installed cursor-copy tuple; preserving it." >&2
      return 10
    fi
    if [ ! -f "$target/.jarvis-cortex-skill.json" ]; then
      echo "warn: $target exists and is not a Jarvis-managed skill; preserving it." >&2
      return 10
    fi
    if "$NODE_BIN" "$CURSOR_COPY_TOOL" owner-verify \
      "$source" "$target" "$previous_source" >/dev/null 2>&1; then
      :
    else
      local ownership_status=$?
      if [ "$ownership_status" -ne 10 ]; then
        return "$ownership_status"
      fi
      echo "warn: $target has a marker with unexpected source identity; preserving it." >&2
      return 10
    fi
    if "$NODE_BIN" "$CURSOR_COPY_TOOL" verify "$source" "$target" >/dev/null 2>&1; then
      return 0
    fi
  fi
  local transaction_token
  transaction_token="$("$NODE_BIN" "$CURSOR_COPY_TOOL" sync \
    "$source" "$target" "$previous_source" --defer-finalize)" || return $?
  [ -n "$transaction_token" ] || return 1
  record_copy_transaction "$transaction_token"
}

copy_gstack_skill() {
  local source="$1" target="$2" previous_source="$3" name="$4" provenance="$5"
  local previous_mode="$6" previous_provenance="$7"
  if [ -L "$target" ]; then
    if is_legacy_gstack_copy_link \
      "$target" "$name" "$provenance" "$previous_mode" "$previous_provenance"; then
      unlink "$target"
    else
      echo "warn: $target exists and is not a Jarvis-managed symlink; preserving it." >&2
      return 10
    fi
  elif [ -e "$target" ]; then
    if [ "${HAD_MANAGED_MANIFEST:-1}" -eq 1 ] \
      && { [ "$previous_mode" != "gstack-copy" ] || [ "$previous_provenance" != "$provenance" ]; }; then
      echo "warn: $target is not backed by the exact installed gstack-copy tuple; preserving it." >&2
      return 10
    fi
    if "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-owner-verify \
      "$source" "$target" "$previous_source" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
      :
    else
      local ownership_status=$?
      if [ "$ownership_status" -ne 10 ]; then
        return "$ownership_status"
      fi
      echo "warn: $target exists and is not a Jarvis-managed gstack skill; preserving it." >&2
      return 10
    fi
    if "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-verify \
      "$source" "$target" "" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
      return 0
    fi
  fi
  local transaction_token
  transaction_token="$("$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-sync \
    "$source" "$target" "$previous_source" "$GSTACK_REPO_ROOT" --defer-finalize)" || return $?
  [ -n "$transaction_token" ] || return 1
  record_copy_transaction "$transaction_token"
}

# --- Hook scripts (symlinks into cortex; git tracks +x — do not chmod symlink) ---
for hook in rtk-shell.js enforce-cursor.js session-start.js; do
  src="$REPO_ROOT/cursor/hooks/$hook"
  if [ -f "$src" ]; then
    link_file "$src" "$CURSOR_HOME/hooks/$hook"
  fi
done

# --- permissions.json: explicit no-prompt mode requested by the user ---
link_file "$REPO_ROOT/cursor/permissions.json" "$CURSOR_HOME/permissions.json"

# --- hooks.json: merge jarvis-managed hook commands, preserve others ---
command "$NODE_BIN" - "$REPO_ROOT/cursor/hooks.json" "$CURSOR_HOME/hooks.json" <<'NODE'
const fs = require('fs');
const [templatePath, targetPath] = process.argv.slice(2);
const JARVIS_CMDS = new Set([
  './hooks/session-start.js',
  './hooks/rtk-shell.js',
  './hooks/enforce-cursor.js',
]);
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
let existing = { version: 1, hooks: {} };
const targetStat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
if (targetStat) {
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`unsafe hooks.json destination: ${targetPath}`);
  }
  try {
    existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    const backup = `${targetPath}.backup.${Date.now()}`;
    fs.copyFileSync(targetPath, backup, fs.constants.COPYFILE_EXCL);
    console.error(`Backed up unreadable hooks.json to ${backup}`);
  }
}
existing.version = existing.version || template.version || 1;
existing.hooks = existing.hooks || {};
for (const [event, hooks] of Object.entries(template.hooks || {})) {
  const current = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
  const kept = current.filter((h) => !JARVIS_CMDS.has(h && h.command));
  existing.hooks[event] = [...kept, ...hooks];
}
const temporary = `${targetPath}.jarvis-tmp-${process.pid}-${Date.now()}`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, targetPath);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  throw error;
}
NODE

# --- mcp.json: merge jarvis-owned servers; warn before overwriting customized managed keys ---
command "$NODE_BIN" - "$REPO_ROOT/cursor/mcp.json" "$CURSOR_HOME/mcp.json" <<'NODE'
const fs = require('fs');
const [templatePath, targetPath] = process.argv.slice(2);
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
let existing = { mcpServers: {} };
const targetStat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
if (targetStat) {
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`unsafe mcp.json destination: ${targetPath}`);
  }
  try {
    existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    const backup = `${targetPath}.backup.${Date.now()}`;
    fs.copyFileSync(targetPath, backup, fs.constants.COPYFILE_EXCL);
    console.error(`Backed up unreadable mcp.json to ${backup}`);
  }
}
existing.mcpServers = existing.mcpServers || {};
for (const [name, cfg] of Object.entries(template.mcpServers || {})) {
  const prev = existing.mcpServers[name];
  if (prev && JSON.stringify(prev) !== JSON.stringify(cfg)) {
    const backup = `${targetPath}.managed-${name}.backup.${Date.now()}`;
    fs.writeFileSync(backup, JSON.stringify({ [name]: prev }, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.error(`warn: overwriting customized mcpServers.${name}; previous saved to ${backup}`);
  }
  existing.mcpServers[name] = cfg;
}
const temporary = `${targetPath}.jarvis-tmp-${process.pid}-${Date.now()}`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, targetPath);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  throw error;
}
NODE

# --- alwaysApply rule ---
link_file "$REPO_ROOT/cursor/rules/jarvis-cortex.mdc" "$CURSOR_HOME/rules/jarvis-cortex.mdc"

# --- Skills: curated native tree ---
# Cursor's third-party compatibility scanner recursively imports ~/.claude and
# ~/.codex skill trees. Full source repos and backup directories under those
# roots become duplicate skills. Keep Cursor self-contained so that third-party
# imports can stay disabled in Settings → Rules, Skills and Subagents.
DESIRED_MANIFEST_NAME=".jarvis-cortex-skills.desired.$$"
INSTALLED_MANIFEST_NAME=".jarvis-cortex-skills.installed.$$"
MANAGED_MANIFEST_NAME="jarvis-cortex-skills.manifest.tsv"
DESIRED_MANIFEST="$CURSOR_HOME_PHYSICAL/$DESIRED_MANIFEST_NAME"
INSTALLED_MANIFEST="$CURSOR_HOME_PHYSICAL/$INSTALLED_MANIFEST_NAME"
MANAGED_MANIFEST="$CURSOR_HOME_PHYSICAL/$MANAGED_MANIFEST_NAME"
HAD_MANAGED_MANIFEST=0
[ -f "$MANAGED_MANIFEST" ] && HAD_MANAGED_MANIFEST=1
# Bash 3.2 + `set -u` treats an initialized empty array expansion as unbound.
# Keep an inert slot zero so every indexed loop is nounset-safe.
COPY_TRANSACTION_TOKENS=("")
COPY_ATTESTATION_TOKENS=("")
MANIFEST_PUBLISHED=0
record_copy_transaction() {
  COPY_TRANSACTION_TOKENS+=("$1")
}
rollback_copy_transactions() {
  local index
  for ((index=${#COPY_TRANSACTION_TOKENS[@]} - 1; index >= 1; index--)); do
    "$NODE_BIN" "$CURSOR_ANCHORED_FS" rollback "${COPY_TRANSACTION_TOKENS[$index]}" || true
  done
  COPY_TRANSACTION_TOKENS=("")
}
finalize_copy_transactions() {
  local index finalize_output finalize_status
  for ((index=1; index<${#COPY_TRANSACTION_TOKENS[@]}; index++)); do
    finalize_output=""
    if finalize_output="$("$NODE_BIN" "$CURSOR_ANCHORED_FS" finalize \
        "${COPY_TRANSACTION_TOKENS[$index]}" 2>&1)"; then
      :
    else
      finalize_status=$?
      finalize_output="${finalize_output#Cursor anchored filesystem operation failed: }"
      echo "warn: Cursor copy committed; ${finalize_output:-transaction cleanup failed outside Cursor skills (exit $finalize_status)}" >&2
    fi
  done
  COPY_TRANSACTION_TOKENS=("")
}
cleanup_temporary_manifests() {
  local original_status=$?
  if [ "${MANIFEST_PUBLISHED:-0}" -eq 0 ]; then
    rollback_copy_transactions
  fi
  [ -z "${DESIRED_MANIFEST_NAME:-}" ] \
    || "$NODE_BIN" "$CURSOR_ANCHORED_FS" remove "$CURSOR_HOME_ANCHOR" "$DESIRED_MANIFEST_NAME" >/dev/null 2>&1 \
    || true
  [ -z "${INSTALLED_MANIFEST_NAME:-}" ] \
    || "$NODE_BIN" "$CURSOR_ANCHORED_FS" remove "$CURSOR_HOME_ANCHOR" "$INSTALLED_MANIFEST_NAME" >/dev/null 2>&1 \
    || true
  return "$original_status"
}
trap cleanup_temporary_manifests EXIT
printf '%s\n' "$DESIRED_SKILL_PLAN" \
  | command "$NODE_BIN" "$CURSOR_ANCHORED_FS" write-private \
    "$CURSOR_HOME_ANCHOR" "$DESIRED_MANIFEST_NAME"
printf '' | command "$NODE_BIN" "$CURSOR_ANCHORED_FS" write-private \
  "$CURSOR_HOME_ANCHOR" "$INSTALLED_MANIFEST_NAME"

append_installed_manifest() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" \
    | command "$NODE_BIN" "$CURSOR_ANCHORED_FS" append-private \
      "$CURSOR_HOME_ANCHOR" "$INSTALLED_MANIFEST_NAME"
}

GSTACK_RUNTIME="$CURSOR_HOME/jarvis-runtime/gstack"
gstack_root_from_manifest() {
  local manifest="$1"
  [ -f "$manifest" ] || return 0
  command "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const roots = new Set();
    for (const line of fs.readFileSync(process.argv[1], "utf8").split(/\n/)) {
      const [name, source, mode, provenance] = line.split("\t");
      if (provenance !== "gstack") continue;
      if (!name || !source || mode !== "gstack-copy") process.exit(0);
      const resolved = path.resolve(source);
      const root = path.dirname(path.dirname(path.dirname(resolved)));
      if (path.dirname(resolved) !== path.join(root, ".cursor", "skills")
        || !path.basename(resolved)) process.exit(0);
      roots.add(root);
    }
    if (roots.size === 1) process.stdout.write([...roots][0]);
  ' "$manifest"
}

PREVIOUS_GSTACK_ROOT="$(gstack_root_from_manifest "$MANAGED_MANIFEST")"
CURRENT_GSTACK_ROOT="$(gstack_root_from_manifest "$DESIRED_MANIFEST")"
gstack_manifest_present="$(command "$NODE_BIN" -e '
  const fs = require("fs");
  process.stdout.write(fs.readFileSync(process.argv[1], "utf8").split(/\n/)
    .some((line) => line.split("\t")[3] === "gstack") ? "yes" : "no");
' "$DESIRED_MANIFEST")"
if [ "$gstack_manifest_present" = "yes" ]; then
  if [ -z "$CURRENT_GSTACK_ROOT" ]; then
    echo "error: desired Cursor gstack rows do not share one canonical source root" >&2
    exit 1
  fi
  if [ -e "$GSTACK_RUNTIME" ] || [ -L "$GSTACK_RUNTIME" ]; then
    if "$NODE_BIN" "$CURSOR_GSTACK_TOOL" runtime-owner-verify \
      "$CURRENT_GSTACK_ROOT" "$GSTACK_RUNTIME" "$PREVIOUS_GSTACK_ROOT" >/dev/null 2>&1; then
      :
    else
      runtime_ownership_status=$?
      if [ "$runtime_ownership_status" -ne 10 ]; then
        exit "$runtime_ownership_status"
      fi
      echo "error: $GSTACK_RUNTIME exists and is not a Jarvis-managed gstack runtime; preserving it." >&2
      exit 1
    fi
    if ! "$NODE_BIN" "$CURSOR_GSTACK_TOOL" runtime-verify "$CURRENT_GSTACK_ROOT" "$GSTACK_RUNTIME" "$CURSOR_SKILLS" >/dev/null 2>&1; then
      command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" runtime-sync \
        "$CURRENT_GSTACK_ROOT" "$GSTACK_RUNTIME" "$CURSOR_SKILLS" "$PREVIOUS_GSTACK_ROOT"
    fi
  else
    command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" runtime-sync \
      "$CURRENT_GSTACK_ROOT" "$GSTACK_RUNTIME" "$CURSOR_SKILLS" "$PREVIOUS_GSTACK_ROOT"
  fi
elif [ -e "$GSTACK_RUNTIME" ] || [ -L "$GSTACK_RUNTIME" ]; then
  if [ -n "$PREVIOUS_GSTACK_ROOT" ]; then
    if "$NODE_BIN" "$CURSOR_GSTACK_TOOL" runtime-remove \
      "$PREVIOUS_GSTACK_ROOT" "$GSTACK_RUNTIME" "$PREVIOUS_GSTACK_ROOT" >/dev/null; then
      :
    else
      runtime_remove_status=$?
      if [ "$runtime_remove_status" -eq 10 ]; then
        echo "warn: $GSTACK_RUNTIME does not match the previously managed gstack runtime; preserving it." >&2
      else
        exit "$runtime_remove_status"
      fi
    fi
  else
    echo "warn: $GSTACK_RUNTIME exists without a previous managed gstack source; preserving it." >&2
  fi
fi

previous_source_for() {
  local wanted="$1"
  [ -f "$MANAGED_MANIFEST" ] || return 0
  command "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, wanted] = process.argv.slice(1);
    for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
      const [name, source] = line.split("\t");
      if (name === wanted) { process.stdout.write(source || ""); break; }
    }
  ' "$MANAGED_MANIFEST" "$wanted"
}

previous_field_for() {
  local wanted="$1" field_index="$2"
  [ -f "$MANAGED_MANIFEST" ] || return 0
  command "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, wanted, fieldIndex] = process.argv.slice(1);
    for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
      const fields = line.split("\t");
      if (fields[0] === wanted) { process.stdout.write(fields[Number(fieldIndex)] || ""); break; }
    }
  ' "$MANAGED_MANIFEST" "$wanted" "$field_index"
}

manifest_has_name() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, wanted] = process.argv.slice(1);
    process.exit(fs.readFileSync(file, "utf8").split(/\n/).some((line) => line.split("\t")[0] === wanted) ? 0 : 1);
  ' "$DESIRED_MANIFEST" "$1"
}

manifest_has_row() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, ...wanted] = process.argv.slice(1);
    process.exit(fs.readFileSync(file, "utf8").split(/\n/).some((line) => {
      const fields = line.split("\t");
      return fields.length === 4 && fields.every((field, index) => field === wanted[index]);
    }) ? 0 : 1);
  ' "$DESIRED_MANIFEST" "$1" "$2" "$3" "$4"
}

manifest_has_ownership() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, wantedName, wantedMode, wantedProvenance] = process.argv.slice(1);
    process.exit(fs.readFileSync(file, "utf8").split(/\n/).some((line) => {
      const [name, , mode, provenance] = line.split("\t");
      return name === wantedName && mode === wantedMode && provenance === wantedProvenance;
    }) ? 0 : 1);
  ' "$DESIRED_MANIFEST" "$1" "$2" "$3"
}

is_recorded_skill_link() {
  local target="$1" recorded_source="$2" name="$3" mode="$4" provenance="$5"
  "$NODE_BIN" "$CURSOR_STALE_LINK_GUARD" verify \
    "$REPO_ROOT" "$GSTACK_REPO_ROOT" "$name" "$recorded_source" "$mode" "$provenance" "$target"
}

# Reconcile every previously managed row that is no longer desired exactly.
# Ownership is checked against the previous row before removal; mismatches are
# user-owned collisions and remain untouched.
if [ -f "$MANAGED_MANIFEST" ]; then
  while IFS=$'\t' read -r name source mode provenance; do
    [ -n "$name" ] || continue
    if manifest_has_row "$name" "$source" "$mode" "$provenance"; then
      continue
    fi
    # A same-name copy relocation is replaced by the copy tool's staged,
    # rollback-safe sync. Pruning it here would destroy the valid previous
    # target before the new source has passed recursive validation.
    case "$mode:$provenance" in
      cursor-copy:cortex|gstack-copy:gstack)
        if manifest_has_ownership "$name" "$mode" "$provenance"; then
          continue
        fi
        ;;
    esac
    case "$name" in
      .|..|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]*)
        echo "warn: invalid stale Cursor manifest name; preserving all targets." >&2
        continue
        ;;
    esac
    case "$source" in
      /*) ;;
      *)
        echo "warn: stale Cursor manifest source for $name is not absolute; preserving target." >&2
        continue
        ;;
    esac
    target="$CURSOR_SKILLS/$name"
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      continue
    fi
    case "$mode:$provenance" in
      link:cortex|link:hm|link:caveman)
        if [ -L "$target" ] && is_recorded_skill_link "$target" "$source" "$name" "$mode" "$provenance"; then
          unlink "$target"
        else
          echo "warn: stale Cursor link $target does not match its previous manifest row; preserving it." >&2
        fi
        ;;
      cursor-copy:cortex)
        prune_output=""
        if prune_output="$("$NODE_BIN" "$CURSOR_COPY_TOOL" remove "$source" "$target" "$source" 2>&1)"; then
          :
        else
          prune_status=$?
          if [ "$prune_status" -eq 10 ]; then
            echo "warn: stale Cursor copy $target does not match its previous manifest row; preserving it." >&2
          else
            [ -z "$prune_output" ] || printf '%s\n' "$prune_output" >&2
            exit "$prune_status"
          fi
        fi
        ;;
      gstack-copy:gstack)
        prune_output=""
        if prune_output="$("$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-remove \
          "$source" "$target" "$source" "$GSTACK_REPO_ROOT" 2>&1)"; then
          :
        else
          prune_status=$?
          if [ "$prune_status" -eq 10 ]; then
            echo "warn: stale Cursor gstack copy $target does not match its previous manifest row; preserving it." >&2
            # If the registered generated source became unavailable, keep the exact
            # installed tuple as fail-closed recovery state. The next run may
            # reclaim the target only after that same source returns and the
            # normal marker/source ownership verification succeeds. Dropping
            # this row would make an intact Jarvis marker indistinguishable
            # from an unregistered target on the following run.
            if "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-orphan-verify \
                "$source" "$target" "$source" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
              append_installed_manifest "$name" "$source" "$mode" "$provenance"
            fi
          else
            [ -z "$prune_output" ] || printf '%s\n' "$prune_output" >&2
            exit "$prune_status"
          fi
        fi
        ;;
      *)
        echo "warn: stale Cursor manifest row for $name has unexpected mode/provenance; preserving target." >&2
        ;;
    esac
  done < "$MANAGED_MANIFEST"
fi

# Migrate generated links from the pre-manifest installer without letting a
# current/injected manifest row re-enable this one-time ownership exception.
if [ "$HAD_MANAGED_MANIFEST" -eq 0 ]; then
  for target in "$CURSOR_SKILLS"/gstack*; do
    [ -L "$target" ] || continue
    # Parameter expansion, NOT $(basename): this is the highest-stakes capture
    # in the file — four lines below is an `unlink` with no park. $( ) eats a
    # trailing newline, so a foreign target named "gstack"$'\n' captured as
    # "gstack", was misclassified as the ordinary generated link by the legacy
    # ownership check, and was DELETED WITHOUT PARKING. Measured:
    # captured=gstack exact=$'gstack\n'. $target always contains a slash here
    # (it comes from the "$CURSOR_SKILLS"/gstack* glob), so ${target##*/} is
    # exact and needs no helper.
    name="${target##*/}"
    manifest_has_name "$name" && continue
    if is_exact_generated_gstack_link "$target" "$GSTACK_CURSOR_SKILLS/$name" \
      || { [ "$name" = "gstack" ] && link_targets_source_exactly "$target" "$GSTACK_REPO_ROOT"; }; then
      unlink "$target"
    fi
  done
fi

while IFS=$'\t' read -r name source mode provenance; do
  previous_source="$(previous_source_for "$name")"
  previous_mode="$(previous_field_for "$name" 2)"
  previous_provenance="$(previous_field_for "$name" 3)"
  target="$CURSOR_SKILLS/$name"
  managed=0
  if [ "$mode" = "cursor-copy" ]; then
    if copy_skill "$source" "$target" "$previous_source" "$name" "$provenance" \
      "$previous_mode" "$previous_provenance"; then
      managed=1
    else
      install_status=$?
      [ "$install_status" -eq 10 ] || exit "$install_status"
    fi
  elif [ "$mode" = "gstack-copy" ]; then
    if copy_gstack_skill "$source" "$target" "$previous_source" "$name" "$provenance" \
      "$previous_mode" "$previous_provenance"; then
      managed=1
    else
      install_status=$?
      [ "$install_status" -eq 10 ] || exit "$install_status"
    fi
  else
    if link_skill "$source" "$target" "$previous_source" "$name" "$mode" "$provenance" \
      "$previous_mode" "$previous_provenance"; then
      managed=1
    else
      install_status=$?
      [ "$install_status" -eq 10 ] || exit "$install_status"
    fi
  fi
  if [ "$managed" -eq 1 ]; then
    append_installed_manifest "$name" "$source" "$mode" "$provenance"
  fi
done < "$DESIRED_MANIFEST"

# Reverify every committed copy immediately before publishing the manifest.
# Tokens also prove that the public target lookup still resolves to the exact
# inode committed under the anchored skills directory.
for ((transaction_index=1; transaction_index<${#COPY_TRANSACTION_TOKENS[@]}; transaction_index++)); do
  command "$NODE_BIN" "$CURSOR_ANCHORED_FS" assert-transaction \
    "${COPY_TRANSACTION_TOKENS[$transaction_index]}"
done
while IFS=$'\t' read -r name source mode provenance; do
  [ -n "$name" ] || continue
  target="$CURSOR_SKILLS/$name"
  case "$mode:$provenance" in
    cursor-copy:cortex)
      command "$NODE_BIN" "$CURSOR_COPY_TOOL" verify "$source" "$target" >/dev/null
      COPY_ATTESTATION_TOKENS+=("$(
        command "$NODE_BIN" "$CURSOR_COPY_TOOL" attest "$source" "$target"
      )")
      ;;
    gstack-copy:gstack)
      if manifest_has_row "$name" "$source" "$mode" "$provenance"; then
        command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-verify \
          "$source" "$target" "" "$GSTACK_REPO_ROOT" >/dev/null
        COPY_ATTESTATION_TOKENS+=("$(
          command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-attest \
            "$source" "$target" "" "$GSTACK_REPO_ROOT"
        )")
      else
        # A previously managed exact tuple whose checkout is temporarily
        # offline is intentionally retained as recovery state. Revalidate the
        # installed tree and marker without requiring the missing source; an
        # existing-but-unsafe source still fails closed in orphan verification.
        command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-orphan-verify \
          "$source" "$target" "$source" "$GSTACK_REPO_ROOT" >/dev/null
        COPY_ATTESTATION_TOKENS+=("$(
          command "$NODE_BIN" "$CURSOR_GSTACK_TOOL" skill-orphan-attest \
            "$source" "$target" "$source" "$GSTACK_REPO_ROOT"
        )")
      fi
      ;;
  esac
done < "$INSTALLED_MANIFEST"
MANIFEST_EXPECTATION="$(command "$NODE_BIN" "$CURSOR_ANCHORED_FS" snapshot-private \
  "$CURSOR_HOME_ANCHOR" "$INSTALLED_MANIFEST_NAME")"
TERMINAL_PUBLISH_ARGS=(
  terminal-publish
  "$CURSOR_HOME_ANCHOR"
  "$CURSOR_SKILLS_ANCHOR"
  "$PUBLIC_CURSOR_HOME"
  "$MANIFEST_EXPECTATION"
  "$INSTALLED_MANIFEST_NAME"
  "$MANAGED_MANIFEST_NAME"
)
for ((transaction_index=1; transaction_index<${#COPY_TRANSACTION_TOKENS[@]}; transaction_index++)); do
  TERMINAL_PUBLISH_ARGS+=(--transaction "${COPY_TRANSACTION_TOKENS[$transaction_index]}")
done
for ((attestation_index=1; attestation_index<${#COPY_ATTESTATION_TOKENS[@]}; attestation_index++)); do
  TERMINAL_PUBLISH_ARGS+=(--attestation "${COPY_ATTESTATION_TOKENS[$attestation_index]}")
done
command "$NODE_BIN" "$CURSOR_ANCHORED_FS" "${TERMINAL_PUBLISH_ARGS[@]}"
MANIFEST_PUBLISHED=1
finalize_copy_transactions
command "$NODE_BIN" "$CURSOR_ANCHORED_FS" remove \
  "$CURSOR_HOME_ANCHOR" "$DESIRED_MANIFEST_NAME"
DESIRED_MANIFEST_NAME=""
INSTALLED_MANIFEST_NAME=""
trap - EXIT

echo "Cursor skills: reconciled native manifest in $CURSOR_SKILLS."
third_party_state="$(cursor_third_party_state)"
if [ "$third_party_state" = "off" ]; then
  echo "Cursor third-party imports: verified disabled."
else
  echo "warn: Cursor third-party imports are not proven disabled ($third_party_state). Doctor will FAIL until Settings → Rules, Skills and Subagents → 'Include Third-Party Plugins, Skills, and Other Configs' is off." >&2
fi

echo "Cursor bootstrap complete."
echo "Cortex root: $REPO_ROOT"
echo "Cursor home: $CURSOR_HOME"
echo "Reload Cursor (Cmd+Shift+P → Reload Window) to pick up MCP + hooks."
