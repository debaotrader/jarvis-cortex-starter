#!/usr/bin/env bash
set -euo pipefail

# --- INHERITED-STATE BOUNDARY ----------------------------------------------
# Ported from scripts/bootstrap-codex.sh, which carries the full four-category
# taxonomy (external binaries -> `command`; shell builtins -> `builtin`;
# environment variables -> the assignments below; shell options -> `set +f`)
# and the honest statement that the enumeration is OPEN, not closed. Read that
# block before adding another prefix or another "this is now closed" claim.
# Only what is LIVE IN THIS FILE is restated here; the rest would be a stale
# copy, and a stale boundary document is worse than a pointer to the live one.
#
# --- TIER A: correctable in-script — FIXED ---------------------------------
#   CDPATH      LIVE, fixed. When `cd` is given a BARE RELATIVE operand and
#               selects a NONEMPTY CDPATH entry it PRINTS the directory it
#               chose, and that line lands INSIDE the $( ) capture — two lines
#               where the code requires one, corrupting the value the whole
#               topology gate is built on. It bites when this script is invoked
#               as `bash scripts/bootstrap-claude.sh`, because BASH_SOURCE is
#               then relative and dirname yields a bare "scripts". The irony is
#               exact: this discipline exists to preserve a TRAILING newline,
#               and CDPATH injects a LEADING line. Neutralised here AND locally
#               in every helper that runs `cd`.
#   noglob      LIVE, fixed by `set +f`. Inherited through SHELLOPTS it makes
#               globs literal, and this file has two that matter: the HM loop
#               (`codex/skills-local/hm-*`) would iterate the literal pattern,
#               fail `[ -d ]`, link ZERO of the 13 HM skills and still exit 0;
#               the caveman statusline `ls` glob would likewise never match.
#   GLOBIGNORE  NOT live across a process boundary (an exported value is present
#   IFS         in a child bash's environment but does not filter its globs; and
#               bash resets IFS at startup regardless of the environment). Both
#               assignments are retained for the SOURCED case only.
#
# --- TIER B: pre-entry — ACCEPTED and named --------------------------------
#   BASH_ENV/ENV, noexec, xtrace/PS4, PATH, and FUNCTION SHADOWING act before,
#   or outside, anything this script can assign. The `builtin` prefixes below
#   defend against ACCIDENTAL shadowing — `cd() { builtin cd "$@" && ls; }` with
#   `export -f cd` is an ordinary bashrc idiom and it propagates into a child
#   `bash script.sh`. They are NOT a trust boundary: shim `cd`, then `builtin`,
#   then `command`, and nothing is left, because every escape is itself a name.
#   The honest boundary is that an adversary who can set any of these already
#   executes code as the user; this script is not setuid and crosses no
#   privilege boundary. Accepted threat model, same as the siblings.
#
# NOT ported, deliberately: `umask 022` and the `chmod go-w` on the backup root.
# They are a permissions hardening, not a containment mechanism, and this port
# is scoped to containment. Named here so the divergence from the siblings is a
# recorded decision rather than an oversight.
# ---------------------------------------------------------------------------
CDPATH=
GLOBIGNORE=
IFS=$' \t\n'
set +f          # noglob: inherited via SHELLOPTS, makes globs literal
umask 022       # a mode you did not assert is a mode you inherited

# Resolve the checkout physically before deriving any managed source path.
# CLAUDE.md documents invoking this through ~/.codex/jarvis-cortex, which on
# this machine is a symlink to the real checkout. A logical `pwd` would bake
# whichever spelling the user typed into every symlink target, so the next run
# through the other spelling would see every link as foreign.
#
# Both derivations go through the exact-capture helpers below rather than a
# bare $( ). $( ) strips EVERY trailing newline and both `pwd -P` and `dirname`
# terminate their output with one, so a checkout directory literally named
# "<name>"$'\n' collapses onto its newline-free sibling "<name>". REPO_ROOT
# would then name a DIFFERENT directory than the one this script lives in, and
# every containment decision below (SOURCE_ROOT, PROTECTED_TREES, MANAGED_TREES,
# MANAGED_LEAVES) would guard that sibling while the real checkout stayed open.

# Exact capture, same discipline as read_link_exact below: append an inert X
# sentinel so $( ) has something of its own to eat, strip it, then strip the ONE
# delimiter the command itself appended. Results land in globals on purpose —
# wrapping a call in a second $( ) would re-eat the newline. Note `local
# x="$(cmd)"` is NOT used anywhere here: `local` always returns 0 and would
# swallow the command's status.
dirname_exact() {
  DIRNAME_EXACT="$(dirname -- "$1" && printf X)" || { DIRNAME_EXACT=""; return 1; }
  DIRNAME_EXACT="${DIRNAME_EXACT%X}"
  DIRNAME_EXACT="${DIRNAME_EXACT%$'\n'}"
  [ -n "$DIRNAME_EXACT" ]
}

physical_dir_exact() {
  # `local CDPATH=`: with CDPATH set, `cd` PRINTS the directory it chose and
  # that line lands inside the capture below. Belt and braces with the global
  # assignment above — this helper is the primitive the whole topology gate
  # rests on.
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
# The exact capture above makes a newline in the checkout's own name VISIBLE
# rather than silently collapsing it onto a newline-free sibling. Having made it
# visible, REFUSE it — the exactness guarantee dies at the process boundary.
# This script hands off to scripts/install-mattpocock-skills.sh and
# scripts/setup-graphify-brain.sh, and BOTH re-derive their own roots with bare
# $( ) captures (`SCRIPT_DIR="$(cd -- "$(dirname -- …)" && pwd)"`, and
# mattpocock additionally `target_home="$(dirname -- "$TARGET_SKILLS")"`); those
# captures collapse onto the sibling, so the delegates would act on the WRONG
# TREE. Passing the exact value through is not available: the delegates would
# have to be changed to consume it, that is outside this port's scope, and a
# binding the callee does not honour is worse than a refusal it cannot ignore.
# Same REJECT choice, for the same reason, as the `..` component in
# anchor_existing_dir.
case "$REPO_ROOT" in
  *$'\n'*)
    echo "Refusing a cortex checkout whose path contains a newline: $REPO_ROOT" >&2
    exit 1
    ;;
esac
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
# Kept overridable, unlike the siblings' hardcoded BACKUP_ROOT: this knob
# predates the topology gate, is documented in docs/ARCHITECTURE.md, and its
# refusal path is pinned by tests/installer-preservation.test.js. The sibling's
# rationale — no ungated destination — is satisfied a different way here: the
# value is gated by assert_managed_topology below (it is a MANAGED_TREES entry
# and the backup root argument), so the capability survives without the hole.
# ONE variable, deliberately: the gate reads exactly the string backup_target
# mutates, so there is no second name that could guard a different path.
CLAUDE_BACKUP_DIR="${CLAUDE_BACKUP_DIR:-$CLAUDE_HOME/backups}"

SOURCE_ROOT="$REPO_ROOT"
# Bash 3.2 + `set -u`: slot zero is inert so the indexed loops are nounset-safe.
#
# Only the checkout. The siblings also list their skills tree here, which this
# file deliberately does NOT: backup_target already resolves $CLAUDE_BACKUP_DIR
# physically and refuses a root inside $CLAUDE_HOME/skills with its own message
# ("Refusing to write backups inside the skills tree"), and that message is the
# pinned contract. Listing the skills tree here would pre-empt it with a
# different string. Nothing is lost — the skills tree is a MANAGED_TREES entry,
# so its containment relative to the checkout IS gated below; what stays in
# backup_target is only the discoverability check (a preserved skill must not
# remain discoverable AS a skill), which is not a containment concern.
PROTECTED_TREES=("" "$REPO_ROOT")
# install-mattpocock-skills.sh derives CACHE_DIR from MATTPOCOCK_CACHE and then
# runs `git -C "$CACHE_DIR" remote set-url origin "$MATTPOCOCK_REPO"` on it —
# pointed at this checkout that rewrites THIS CHECKOUT'S git remote — and
# `rm -rf "$CACHE_DIR"` when the path exists without a .git. The callee's own
# `ensure_under "$CACHE_DIR" "$(dirname -- "$CACHE_DIR")"` guard is a tautology
# (a path is always under its own dirname), so it stops nothing. Default matches
# the callee's derivation: dirname of the target skills directory, plus
# /.cache/mattpocock-skills. Gated below and passed EXPLICITLY at the call site,
# so the value gated is exactly the value the delegate receives.
MATTPOCOCK_CACHE_PINNED="${MATTPOCOCK_CACHE:-$CLAUDE_HOME/.cache/mattpocock-skills}"
# Ancestors of every managed link target: the directories link_file `mkdir -p`s
# and then parks whatever occupies a leaf inside. A pre-existing symlink at
# $CLAUDE_HOME/skills pointing to $REPO_ROOT/active/skills passes every other
# check in this file, and link_file's `elif [ -d "$target" ]` branch then MOVES
# the source directory into backups and leaves a self-referential link in its
# place. assert_managed_topology resolves each entry where it really lands and
# refuses any that lands inside the checkout.
#
# $CLAUDE_HOME itself is deliberately NOT listed. The home gets a ONE-WAY check
# (inside the checkout is refused; CONTAINING the checkout is the documented
# ~/.codex/jarvis-cortex layout and is allowed). Every entry in this list
# carries its own REVERSE test, which is where containment protection lives now
# that the home cannot supply it — so an entry that must be allowed to contain
# the checkout does not belong here.
MANAGED_TREES=("" "$CLAUDE_HOME/skills" "$CLAUDE_HOME/agents" \
  "$CLAUDE_HOME/hooks" "$CLAUDE_BACKUP_DIR" "$MATTPOCOCK_CACHE_PINNED")
# Every link_file TARGET under the managed home. These are leaf paths, so
# MANAGED_TREES cannot express them: gating an ancestor does NOT gate a leaf —
# a real directory at $CLAUDE_HOME/active lives INSIDE the gated home and is
# still whatever it is, and link_file's directory branch would move it. A
# checkout at or below one of these passed every topology check before this
# list existed.
#
# KEEP IN SYNC with the link loops below (the same names, same order). The
# enumeration is the PRE-mutation gate; link_file's own directory-branch check
# is the backstop for DRIFT — a target added to a link loop and forgotten here.
#
# It does NOT cover the HM loop, and an earlier version of this comment claimed
# it did. The HM loop never calls link_file: it symlinks when the path is empty
# and WARNs + SKIPs on anything else (see the terminal-branch inventory below),
# so no branch of it can move a pre-existing object in the first place. That is
# why it needs no backstop, not that one covers it.
MANAGED_LEAVES=("" \
  "$CLAUDE_HOME/BOOT.md" "$CLAUDE_HOME/CLAUDE.md" "$CLAUDE_HOME/JARVIS.md" \
  "$CLAUDE_HOME/MEMORY.md" "$CLAUDE_HOME/README.md" "$CLAUDE_HOME/RTK.md" \
  "$CLAUDE_HOME/SETUP.md" "$CLAUDE_HOME/config.json.example" \
  "$CLAUDE_HOME/napkin.md" "$CLAUDE_HOME/settings.json" \
  "$CLAUDE_HOME/active" "$CLAUDE_HOME/commands" "$CLAUDE_HOME/docs" \
  "$CLAUDE_HOME/memory" "$CLAUDE_HOME/scripts" \
  "$CLAUDE_HOME/skills/dead-code-audit" "$CLAUDE_HOME/skills/impeccable" \
  "$CLAUDE_HOME/skills/loop-hermes" "$CLAUDE_HOME/skills/orchestrate" \
  "$CLAUDE_HOME/skills/security-audit" "$CLAUDE_HOME/skills/strategic-compact" \
  "$CLAUDE_HOME/skills/verification-loop" "$CLAUDE_HOME/skills/jarvis-learn" \
  "$CLAUDE_HOME/agents/impeccable-manual-edit-applier.md" \
  "$CLAUDE_HOME/hooks/caveman-statusline.sh")

# Every terminal branch that can meet a pre-existing object, enumerated from
# the code rather than from intent:
#
#   CREATE  — nothing at the path: link_file or the HM loop just symlinks.
#   NO-OP   — link_file finds the canonical link already ours and returns
#             early, or a retired link does not match its known target and is
#             left untouched. Nothing is read further, moved or removed.
#   SKIP    — the HM loop finds ANY other object at its path — real directory,
#             real file, foreign symlink, or dangling symlink (the test is
#             `[ -e ] || [ -L ]`) — warns, leaves it exactly as it is, and
#             does not link that HM skill this run.
#   PARK    — the object is moved into a reserved slot, inode intact. In
#             link_file (real file, real directory, foreign symlink) the new
#             link then takes the freed path; for a MATCHED retired link the
#             object is only moved — nothing replaces it, the path stays empty.
#   UNLINK  — exactly ONE case: a symlink that both resolves and is proven a
#             physical alias of the same source, replaced under the
#             owner-approved exception documented in link_file. That is the
#             only delete of a pre-existing object in this file. A trailing-
#             slash alias of a DIRECTORY source lands here; see link_file.
#   ABORT   — read_link_exact fails on a symlink: link_file reports and
#             returns 1, and set -e stops the bootstrap with the object
#             untouched. backup_target's guards (unresolvable backup dir,
#             backup root inside skills/, unreserved slot) exit the same way.
#   WARN    — the optional externals (mattpocock skills, Graphify Brain) are
#             `|| echo warn` guarded: a failure there leaves no target touched,
#             does NOT stop the run, and the bootstrap still reports complete
#             and exits 0. Cortex-owned linking above has already happened.
#
# No content comparison decides a removal, so there is no comparison to get
# wrong.
#
# KNOWN LIMITATIONS — accepted, not oversights. They fail in DIFFERENT ways,
# and neither occurs in this cortex's actual use:
#   1. `ln -s` after an absence check is a check-then-act. Needs a second
#      bootstrap running concurrently. Failure mode: the loser gets EEXIST and
#      ABORTS under set -e — noisy, nothing touched, even though the winner
#      installed the identical canonical link. No data is lost.
#   2. PARK preserves the inode only for a same-filesystem move. Needs
#      CLAUDE_BACKUP_DIR pointed at another filesystem. Failure mode is NOT an
#      abort: the move SUCCEEDS and the run reports normally, while `mv`
#      silently degrades to copy-then-unlink. Content is preserved; inode
#      identity and hardlinks are not, so "restore by moving it back" returns
#      the bytes but not the same inode. Quieter than 1, and the reason it is
#      called out separately rather than folded into "both just abort".

# Physical path: `cd -P` + `pwd -P` resolve every symlinked component, so a
# backup dir that is itself a symlink into skills/ cannot pass the guard below
# (logical `cd`/`pwd` would report the pretty path and let it through).
physical_path() {
  local CDPATH=   # see physical_dir_exact: CDPATH makes `cd` print its choice
  builtin cd -P -- "$1" 2>/dev/null && builtin pwd -P
}

# Deepest EXISTING directory ancestor of $1, physically resolved, creating
# nothing. Result in ANCHOR_DIR (a global: a $( ) capture would eat a trailing
# newline of the value it is handing back).
#
# This is what lets a managed path that does not exist YET be judged on the
# location it will actually occupy. A `[ -d "$path" ] || return 0` shape would
# wave exactly that case through, so a caller pointing the managed home at a
# not-yet-existing descendant of the checkout would reach the first mutation
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
  # straight back into the checkout. "Inside a tree iff the anchor is" holds
  # only for paths with no upward components.
  #
  # Refusing costs nothing real: every caller passes $CLAUDE_HOME or a fixed
  # child of it, so a `..` can only arrive from a caller-supplied managed home,
  # which has a `..`-free spelling. Normalizing instead would mean re-deriving
  # the path through $( ) and re-opening the truncation hole this file closes.
  case "$path" in
    */../*|*/..) return 1 ;;
  esac
  while [ ! -d "$path" ]; do
    # `${path%/*}` is NOT dirname: for "/foo" it yields the empty string, hence
    # the explicit root fallback.
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

# True when directory $1 is, or lives inside, directory $2 — by inode identity
# at every level. One fully-resolved directory walked upward; no traversal
# model, because both inputs here are fixed paths, not arbitrary user paths
# with "..". Identity rather than string prefix so an APFS firmlink spelling
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
# The managed home is caller-supplied, so (a) a pre-existing `backups` symlink
# makes `mkdir -p` follow it into a protected tree, and (b) a home that overlaps
# the checkout ($CLAUDE_HOME resolving inside $REPO_ROOT) makes a link's source
# and target the same file, so the first backup_target MOVES SOURCE CODE and
# leaves a self-referential link. Measured on this file before the gate existed:
# 8 backup slots under active/backups, seven promoted skill sources replaced by
# links to themselves, sentinel file unreadable — and exit 0.
#
# Three distinct comparisons, deliberately not merged. The HOME is checked
# against $SOURCE_ROOT ONE WAY only — inside the checkout is refused, containing
# it is the documented layout and is allowed. The BACKUP ROOT is checked against
# every protected tree one-way. Every MANAGED TREE is checked against
# $SOURCE_ROOT in BOTH directions, which is where the reverse protection the
# home cannot provide actually lives.
#
# Nothing here returns early because a path does not exist yet. Every path is
# resolved through anchor_existing_dir, which reports where it WILL land.
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
    # clone there, which makes an ancestor relationship ordinary. In the
    # siblings the reverse test refused exactly that arrangement and every
    # bootstrap aborted having linked nothing; it was removed on purpose.
    #
    # Containment belongs on the concrete DESTINATIONS instead, and that is
    # where it lives: every MANAGED_TREES entry carries its own reverse test
    # below, and MANAGED_LEAVES covers the leaf targets.
    #
    # The forward test above still catches the dangerous case — a home INSIDE
    # the checkout, $CLAUDE_HOME == $REPO_ROOT included, because path_within_tree
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
  # turns the next backup_target into a move of source code.
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
      # directory that CONTAINS the checkout passes it, and the mattpocock cache
      # is then handed to `git remote set-url` and `rm -rf` over a tree holding
      # the cortex. The home deliberately does NOT get this test — a home
      # containing the checkout is the documented layout — which is exactly why
      # the concrete destinations have to carry it.
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
# MANAGED_TREES holds DIRECTORIES; the link targets themselves are leaf paths
# and were never gated. A checkout at or below $CLAUDE_HOME/active passed every
# topology check, and link_file's `elif [ -d "$target" ]` branch then moved it.
#
# SYMLINKS ARE EXCLUDED, deliberately: a symlink at one of these paths must
# still be PARKED by link_file, not refused here. Park-always outranks this
# check, which exists only for real directories that cannot be parked safely.
# That exclusion is also what keeps a RE-RUN green: after the first run every
# leaf is our own symlink.
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
# bytes for a 67-byte target. bootstrap-codex.sh avoids that by inlining the
# capture at its one call site; this script has four, so the assignment keeps
# a single copy of the dance.
#
# DIRECT CALLS ONLY. The result travels in a global, so a call inside $( ), a
# pipeline, or any other subshell assigns in a child that then exits: the
# parent would keep whatever $LINK_RAW held before, which may be an EARLIER
# link's target and can compare equal to the wrong source — and a *successful*
# subshelled call would look like it worked while handing back the old value.
# Every caller therefore clears BOTH $LINK_RAW and its own output variable
# immediately before calling, so the worst case is an empty string.
#
# Empty is conservative everywhere, but it is NOT one behaviour — each caller
# in this file does something different with it:
#   link_file      → nothing compares equal, so the object is PARKED and the
#                    canonical link installed. (A failed read is louder still:
#                    link_file returns 1 and the bootstrap aborts, untouched.
#                    Under a concurrent bootstrap the re-link can hit EEXIST
#                    and abort — see KNOWN LIMITATIONS above.)
#   legacy config.json  → no match, so NO-OP: the retired link is left exactly
#                    as it is, for a later run or the user to deal with.
#   legacy mcp-servers  → no match against either the path or the glob: NO-OP.
#   HM loop        → not our link, so WARN + SKIP: the user's entry is left in
#                    place and the HM skill is simply not linked this run.
LINK_RAW=""
read_link_exact() {
  LINK_RAW="$(readlink -n -- "$1" && printf X)" || { LINK_RAW=""; return 1; }
  LINK_RAW="${LINK_RAW%X}"
}

# Same shape as link_names_same_physical_file in bootstrap-codex.sh: compare
# where the link points physically, not how it is spelled. $3 is the exact raw
# value the caller captured with read_link_exact.
#
# What keeps a FORGED link out of a fast path: the value is read byte-for-byte,
# so "<source>\n" no longer compares equal to "$source", and the newline case
# is rejected outright below, before dirname/basename can truncate it. Do NOT
# credit `[ -e ]` for that — a "<source>\n" twin can exist and resolve (the N2
# fixture builds one); `-e` is a separate, weaker guard for dangling links.
#
# "<source>/" is NOT a forgery and is NOT rejected — be precise here, this is
# the only delete path in the file. Measured behaviour:
#   * source is a FILE ("settings.json/") — the link cannot resolve, `-e`
#     fails, and it is PARKED.
#   * source is a DIRECTORY (".../loop-hermes/") — the link resolves, basename
#     drops the trailing slash and both comparisons match, so it is treated as
#     a physical alias and takes the owner-approved UNLINK path: repointed
#     silently, no backup.
# That second case is INTENDED, not an oversight. "/x/dir/" and "/x/dir" name
# the same directory, so the link is genuinely an alias of the same object —
# exactly what the exception exists for. An auditor reading this path should
# expect a delete there.
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
  # one", not which. (Sibling parity: bootstrap-codex.sh/-cursor.sh already do
  # this; this copy had only $raw.)
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
# nest inside each other. The slot lives in $CLAUDE_BACKUP_DIR, outside the
# skills tree, so a preserved skill stops being a discoverable skill.
#
# The object itself is moved, never rebuilt. read_link_exact CAN read a target
# faithfully, trailing newline and all, so this is not "reconstruction is
# impossible" — it is that moving needs no reconstruction at all: one rename,
# no second write path, no reader/writer pair that could ever disagree about
# the value. (Plain `readlink` without -n and the sentinel WOULD lose a
# trailing newline, which is how a rebuilt link or a sidecar goes wrong.) A
# parked symlink is stored as <base>.original and resolves again once moved
# back where it came from.
backup_target() {
  local target="$1"
  local kind="$2"
  local base root skills slot parked
  base="$(basename -- "$target")"
  mkdir -p "$CLAUDE_BACKUP_DIR" "$CLAUDE_HOME/skills"
  # Backups hold whatever we displaced from the managed home — often the user's
  # own config — so group/other write is never correct on it. The umask above
  # covers what THIS run creates; this covers a root that already existed with
  # looser bits.
  chmod go-w "$CLAUDE_BACKUP_DIR" 2>/dev/null || true
  root="$(physical_path "$CLAUDE_BACKUP_DIR")" || { echo "Cannot resolve backup dir: $CLAUDE_BACKUP_DIR" >&2; exit 1; }
  skills="$(physical_path "$CLAUDE_HOME/skills")" || { echo "Cannot resolve skills dir: $CLAUDE_HOME/skills" >&2; exit 1; }
  case "$root/" in
    "$skills"/*)
      echo "Refusing to write backups inside the skills tree: $root" >&2
      exit 1
      ;;
  esac
  slot="$(mktemp -d "$root/$base.backup.$(date +%Y%m%d%H%M%S).XXXXXX")"
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
  # where the two spellings differ. `${target%/*}` is not dirname — for "/foo"
  # it yields the empty string — hence the explicit root fallback.
  target_dir="${target%/*}"
  [ -n "$target_dir" ] || target_dir=/
  mkdir -p "$target_dir"

  # -L is tested BEFORE -e: -e follows the link, so a symlink must be
  # classified here or it falls into the regular-file/dir branches below.
  if [ -L "$target" ]; then
    raw=""; LINK_RAW=""
    read_link_exact "$target" || {
      echo "error: cannot read symlink $target; refusing to touch it." >&2
      return 1
    }
    raw="$LINK_RAW"
    # Every branch that does not park requires the link to RESOLVE, which
    # preserves anything pointing nowhere. Resolution is not what defeats a
    # forged "<source>\n" though — such a twin can exist and resolve. The
    # byte-for-byte capture above is: the value simply does not compare equal,
    # so the link is parked.
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
      # requires swapping $target inside ~/.claude between the two, during a
      # bootstrap. Removing the fast path instead would bank a backup on every
      # alternation between the two documented cortex spellings, on the owner's
      # own machine. The owner took the race over the churn, deliberately.
      #
      # An atomic replacement was tried and rejected on evidence: staging a
      # link and `mv -f`-ing it over the target follows a symlink-to-DIRECTORY
      # on BSD, and most targets here (active, commands, docs, memory, scripts,
      # every promoted skill) are exactly that — it moved the staged link into
      # the cortex source tree, left the alias unrepointed, and returned 0.
      rm -f "$target"
    else
      backup_target "$target" "symlink -> $raw"
    fi
  elif [ -d "$target" ]; then
    # backup_target is about to MOVE this directory. If it is, or contains, the
    # cortex checkout, that move relocates our own source tree — the same
    # destruction shape the topology gate refuses, reached through a link TARGET
    # instead of a managed ancestor. MANAGED_LEAVES enumerates the fixed targets
    # before the first mutation; this is the backstop for the case where a
    # target is added to a link loop and not to that list — it does not depend
    # on the enumeration staying complete.
    #
    # It does NOT extend to the HM loop, which never reaches link_file: that
    # loop symlinks an empty path and WARNs + SKIPs anything else, so it has no
    # branch that moves a pre-existing object.
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

# Topology gate FIRST. Nothing above this line touches the filesystem, and the
# `mkdir -p` below is the first mutation: a home overlapping the checkout, a
# managed ancestor redirected into it, or a leaf that holds it must be refused
# BEFORE any directory is created, because creation is what makes the following
# link/park loops act on the wrong tree.
assert_managed_topology "$CLAUDE_HOME" "$CLAUDE_BACKUP_DIR"
assert_managed_leaves

mkdir -p "$CLAUDE_HOME" "$CLAUDE_HOME/skills"

for file in BOOT.md CLAUDE.md JARVIS.md MEMORY.md README.md RTK.md SETUP.md config.json.example napkin.md settings.json; do
  if [ -e "$REPO_ROOT/$file" ]; then
    link_file "$REPO_ROOT/$file" "$CLAUDE_HOME/$file"
  fi
done

# Retired links. These are usually dangling (the cortex no longer ships either
# path), so resolution cannot be required here — but the value is read exactly,
# and the match triggers a PARK, never an unlink, so a mismatch in either
# direction costs a backup slot at worst, never the user's link.
legacy_config="$CLAUDE_HOME/config.json"
legacy_target=""
if [ -L "$legacy_config" ]; then
  LINK_RAW=""
  if read_link_exact "$legacy_config"; then legacy_target="$LINK_RAW"; fi
fi
if [ -L "$legacy_config" ] && [ "$legacy_target" = "$REPO_ROOT/config.json" ]; then
  backup_target "$legacy_config" "retired symlink"
  echo "Retired the legacy config.json symlink; recreate local config from config.json.example if needed."
fi

legacy_mcp_servers="$CLAUDE_HOME/mcp-servers"
if [ -L "$legacy_mcp_servers" ]; then
  legacy_target=""; LINK_RAW=""
  if read_link_exact "$legacy_mcp_servers"; then legacy_target="$LINK_RAW"; fi
  if [ "$legacy_target" = "$REPO_ROOT/mcp-servers" ] || [[ "$legacy_target" == */jarvis-cortex/mcp-servers ]]; then
    backup_target "$legacy_mcp_servers" "retired symlink"
    echo "Retired the cortex mcp-servers symlink."
  fi
fi

for dir in active commands docs memory scripts; do
  if [ -d "$REPO_ROOT/$dir" ]; then
    link_file "$REPO_ROOT/$dir" "$CLAUDE_HOME/$dir"
  fi
done

# Promoted cortex skills missing from stock Claude/gstack installs.
# gstack owns the `learn` name in ~/.claude/skills; the cortex correction loop
# is linked as `jarvis-learn` to avoid the collision (renamed from `learn`).
for skill_name in dead-code-audit impeccable loop-hermes orchestrate security-audit strategic-compact verification-loop jarvis-learn; do
  skill_source="$REPO_ROOT/active/skills/$skill_name"
  if [ "$skill_name" = "impeccable" ]; then
    skill_source="$REPO_ROOT/active/claude-skills/impeccable"
  fi
  if [ -d "$skill_source" ]; then
    link_file "$skill_source" "$CLAUDE_HOME/skills/$skill_name"
  fi
done

if [ -f "$REPO_ROOT/active/claude-agents/impeccable-manual-edit-applier.md" ]; then
  link_file "$REPO_ROOT/active/claude-agents/impeccable-manual-edit-applier.md" "$CLAUDE_HOME/agents/impeccable-manual-edit-applier.md"
fi

# Higher Mind (HM) skills — vendored in codex/skills-local/hm-* (cortex-owned).
# These reach Codex via install-codex-skills.sh (it copies all of skills-local),
# but no script linked them into the Claude side until now. Link all 13 from the
# vendored source so HM is transferable to any machine, not just the original.
#
# NOT link_file — deliberate policy difference, do not "simplify" this loop
# into it. link_file preserves a real user directory by MOVING it to
# $CLAUDE_BACKUP_DIR and linking in its place: right for entries the harness
# must have (settings.json, active/, scripts/), where leaving the user's copy
# would silently break hooks and cortex paths. HM names are namespaced cortex
# content, so a real hm-<name> directory can only be the user's own work and
# nothing breaks by leaving it exactly where it is — so this loop never moves
# it: skip + warn, mirroring install-codex-skills.sh's promoted-skill loop.
# Re-link only what is already our own symlink (idempotent, no backup).
# The glob auto-covers all 13; `[ -d ] || continue` keeps one missing source from
# aborting. Fatal-safe (no `|| echo warn` wrapper) — unlike the optional externals.
for source in "$REPO_ROOT"/codex/skills-local/hm-*; do
  [ -d "$source" ] || continue
  name="$(basename -- "$source")"
  target="$CLAUDE_HOME/skills/$name"
  # Exact read plus `-e`, same gate as link_file.
  raw=""
  if [ -L "$target" ] && [ -e "$target" ]; then
    LINK_RAW=""
    if read_link_exact "$target"; then raw="$LINK_RAW"; fi
  fi
  if [ "$raw" = "$source" ]; then
    continue
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "warn: $target exists and is not our symlink; skipping (won't overwrite)." >&2
    continue
  fi
  ln -s "$source" "$target"
done

# mattpocock skills (github.com/mattpocock/skills, MIT) — best-effort, non-fatal.
# This runs AFTER the cortex's own promoted skills above so a clone/network
# failure can never prevent them from provisioning. NOTE: this adds a network
# step to an otherwise offline/fast bootstrap; the INSTALL_MATTPOCOCK gate and
# the `|| echo warn` guard keep it optional and non-blocking.
INSTALL_MATTPOCOCK="${INSTALL_MATTPOCOCK:-1}"
if [ "$INSTALL_MATTPOCOCK" = "1" ] && [ -x "$SCRIPT_DIR/install-mattpocock-skills.sh" ]; then
  # MATTPOCOCK_CACHE passed explicitly: that is what makes the MANAGED_TREES
  # gate BINDING. Gating a value the delegate then re-derives from its own
  # environment would guard a path the delegate never uses; passing the gated
  # value means the destination checked here is the destination it receives.
  # The direct-installer override survives — running install-mattpocock-skills.sh
  # yourself still honours the variable.
  MATTPOCOCK_CACHE="$MATTPOCOCK_CACHE_PINNED" \
    "$SCRIPT_DIR/install-mattpocock-skills.sh" "$CLAUDE_HOME/skills" \
    || echo "warn: mattpocock skills install failed (optional, non-fatal); continuing." >&2
fi

# statusLine: settings.json points at $CLAUDE_HOME/hooks/caveman-statusline.sh,
# but statusLine can't use ${CLAUDE_PLUGIN_ROOT} like plugin-registered hooks do.
# The caveman plugin ships the script under its cache dir; link the newest
# installed copy to the path settings.json expects. Skip if caveman isn't
# installed yet (it installs on Claude Code's first launch, after this runs —
# re-run this bootstrap once caveman is present to provision the statusLine).
caveman_statusline="$(ls -t "$CLAUDE_HOME"/plugins/cache/caveman/caveman/*/src/hooks/caveman-statusline.sh 2>/dev/null | head -n 1 || true)"
if [ -n "$caveman_statusline" ] && [ -e "$caveman_statusline" ]; then
  link_file "$caveman_statusline" "$CLAUDE_HOME/hooks/caveman-statusline.sh"
  echo "Linked caveman statusline: $caveman_statusline"
else
  echo "Caveman plugin not installed yet; statusLine will be inactive until you install caveman and re-run this script."
fi

if [ "${SETUP_GRAPHIFY_BRAIN:-1}" = "1" ]; then
  "$SCRIPT_DIR/setup-graphify-brain.sh" --claude \
    || echo "warn: Graphify Brain not configured; clone the private Brain and rerun this bootstrap." >&2
fi

echo "Claude bootstrap complete."
echo "Cortex root: $REPO_ROOT"
echo "Claude home: $CLAUDE_HOME"
echo "Restart Claude Code to reload CLAUDE.md, RTK, hooks, and skills."
