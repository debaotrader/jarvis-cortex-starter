#!/usr/bin/env bash
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
# README/SETUP/AGENTS all document invoking this through ~/.codex/jarvis-cortex,
# which on this machine is a symlink to the real checkout. A logical `pwd` would
# bake whichever spelling the user typed into every symlink target, so the next
# run through the other spelling would see 15 "foreign" links. Physical roots
# make the raw target stable no matter how the script was invoked.
#
# Both derivations go through the exact-capture helpers below rather than a
# bare $( ). $( ) strips EVERY trailing newline and both `pwd -P` and `dirname`
# terminate their output with one, so a checkout directory literally named
# "<name>"$'\n' collapses onto its newline-free sibling "<name>". REPO_ROOT
# would then name a DIFFERENT directory than the one this script lives in, and
# every containment decision below (SOURCE_ROOT, PROTECTED_TREES, MANAGED_TREES)
# would guard that sibling while the real checkout stayed open.

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
# The exact capture above makes a newline in the checkout's own name VISIBLE
# rather than silently collapsing it onto a newline-free sibling. Having made it
# visible, REFUSE it — the exactness guarantee dies at the process boundary.
# This script hands off to scripts/install-codex-skills.sh. That delegate used
# to re-derive its own root with a bare `$(pwd)`, which collapses a
# newline-named checkout onto its sibling and would install sources from the
# WRONG TREE — so the refusal here was the only lever available. The delegate
# now carries the same exact capture and the same refusal, so both ends agree
# rather than one end compensating for the other.
#
# The REJECT choice stands, and not because the other end is weak: a refusal
# the callee cannot ignore is still worth more than a binding it has to be
# trusted to honour, and other delegates further out (install-mattpocock,
# setup-graphify-brain) still derive their own roots. Same reasoning as the
# `..` component in anchor_existing_dir.
case "$REPO_ROOT" in
  *$'\n'*)
    echo "Refusing a cortex checkout whose path contains a newline: $REPO_ROOT" >&2
    exit 1
    ;;
esac
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# Slots are reserved under BACKUP_ROOT, never beside the entry being preserved.
# Not overridable. There is no env knob for this path, so there is no untrusted
# input to validate: the backup root is always a fixed child of $CODEX_HOME, and
# relocating $CODEX_HOME (as every test fixture does) relocates the backups with
# it. Five rounds of validator hardening died here; the capability was the bug.
BACKUP_ROOT="$CODEX_HOME/backups"
SOURCE_ROOT="$REPO_ROOT"
# Bash 3.2 + `set -u`: slot zero is inert so the indexed loop is nounset-safe.
PROTECTED_TREES=("" "$REPO_ROOT" "$CODEX_HOME/skills")
# Ancestors of every managed link target. PROTECTED_TREES only ever covered the
# backup DESTINATION, which does not see this: link_file `mkdir -p`s each of
# these and then parks whatever occupies a leaf inside them. A pre-existing
# symlink at $CODEX_HOME/skills pointing to $REPO_ROOT/codex/agent-skills passes
# every other check in this file, and link_file's `elif [ -d "$target" ]` branch
# then MOVES the source directory into backups and leaves a self-referential
# link in its place. assert_managed_topology resolves each entry where it really
# lands and refuses any that lands inside the checkout.
# $CODEX_HOME itself is deliberately NOT listed. The home gets a ONE-WAY check
# (inside the checkout is refused; CONTAINING the checkout is the documented
# ~/.codex/jarvis-cortex layout and is allowed). This list owns its DESCENDANTS,
# and each entry carries its own reverse test — which is where containment
# protection lives now that the home cannot supply it.
#
# The list must also cover the destinations of the DELEGATED call to
# scripts/install-codex-skills.sh, which this script never writes to itself:
# pinning GSTACK_BACKUP_DIR's spelling was never enough, because the delegate
# `mkdir -p`s it and MOVES entries into it — a pre-existing symlink there
# pointing into the checkout reproduces the C3 destruction through the delegate.
# AGENTS_TARGET_SKILLS was worse: the delegate defaults it to $HOME/.agents/skills
# but honours any ambient value, so it arrived from the environment completely
# ungated. Both are resolved here, gated below, and then passed EXPLICITLY at the
# call site so neither can be inherited. STAGING_PARENT is hardcoded inside the
# delegate, so it only needs gating, not passing.
# The delegate honours THREE destination env vars, not two. GSTACK_MIGRATED_DIR
# is the third: it defaults to $HOME/.gstack/repos/gstack but takes any ambient
# value, and the delegate then runs `git -C "$GSTACK_MIGRATED_DIR" pull`,
# `mkdir -p "$(dirname -- "$GSTACK_MIGRATED_DIR")"` and `git clone … "$GSTACK_MIGRATED_DIR"`
# against it — so an inherited value pointing into the checkout gets git writing
# there. Same treatment as the other two: resolved here, gated below, passed
# explicitly.
GSTACK_BACKUP_DIR_PINNED="$CODEX_HOME/backups/skills"
CORTEX_STAGING_PINNED="$CODEX_HOME/.cortex-staging"
AGENTS_TARGET_SKILLS_PINNED="${AGENTS_TARGET_SKILLS:-$HOME/.agents/skills}"
GSTACK_MIGRATED_DIR_PINNED="${GSTACK_MIGRATED_DIR:-$HOME/.gstack/repos/gstack}"
# A hard CONSTANT, not "${GSTACK_REPO:-…}" like the two above. Those two may
# honour an ambient value because MANAGED_TREES gates where they land;
# GSTACK_REPO is a clone SOURCE URL with no filesystem path to gate, so the only
# available protection is to not honour it at all. It reaches `git clone` and
# then, when bun is present, `(cd "$gstack_setup_dir" && ./setup …)` — arbitrary
# remote code fetched and executed. An ambient value therefore has to stop here.
#
# ACCEPTED RISK — owner-approved, decided, not open. Do not "fix" this.
#
# 1. scripts/install-codex-skills.sh STILL honours GSTACK_REPO when invoked
#    DIRECTLY, and that is deliberate: it is the documented escape hatch for
#    running a fork. What the owner rejected was the value being silently
#    INHERITED through a bootstrap the user did not type it into. Do not remove
#    the callee's default, and do not add URL parsing or a host allowlist here —
#    an allowlist was considered and rejected, because it would put parsing
#    surface back into a script that spent six review rounds removing it.
#
# 2. The gstack clone URL is pinned and gstack's three known state roots
#    (GSTACK_STATE_ROOT, GSTACK_HOME, GSTACK_STATE_DIR) are bound at the call
#    site, so no ambient value is inherited. Beyond those bindings, `./setup` is
#    THIRD-PARTY CODE and what it writes is a TRUST decision, not a containment
#    problem — an environment variable does not sandbox arbitrary code. The
#    owner has accepted that residual explicitly.
#
#    A future round must NOT attempt transitive gating: tracing what `./setup`
#    writes and gating each path would produce a guard valid only until
#    upstream's next commit, and it would encode third-party internals into this
#    script. Sanitize and gate what is OURS, then stop. That line is here on
#    purpose; moving it is a decision for the owner, not for a review round.
GSTACK_REPO_PINNED="https://github.com/garrytan/gstack.git"
# gstack's own state roots. `./setup` reads these from ITS environment and
# ignores the CODEX_HOME we pass, so an ambient value is inherited unless it is
# bound here. All three resolve to $HOME/.gstack in gstack's own defaults
# (`GSTACK_HOME="${GSTACK_STATE_ROOT:-${GSTACK_HOME:-$HOME/.gstack}}"` and
# `STATE_DIR="${GSTACK_STATE_DIR:-$HOME/.gstack}"`), so binding all three to that
# value reproduces default behaviour exactly while closing the inheritance path.
GSTACK_STATE_HOME_PINNED="$HOME/.gstack"
# The SIXTH delegated destination. install-mattpocock-skills.sh derives its
# CACHE_DIR from MATTPOCOCK_CACHE and then runs
#   git -C "$CACHE_DIR" remote set-url origin "$MATTPOCOCK_REPO"
# on it — pointed at this checkout, that rewrites THIS CHECKOUT'S git remote —
# and `rm -rf "$CACHE_DIR"` when the path exists without a .git. The callee's
# own `ensure_under "$CACHE_DIR" "$(dirname -- "$CACHE_DIR")"` guard is a
# tautology (a path is always under its own dirname), so it stops nothing.
# Default matches the callee's derivation: dirname of the target skills
# directory, plus /.cache/mattpocock-skills.
MATTPOCOCK_CACHE_PINNED="${MATTPOCOCK_CACHE:-$CODEX_HOME/.cache/mattpocock-skills}"
# scripts/update-karpathy-skills.sh (reached via the delegate, line
# `"$SCRIPT_DIR/update-karpathy-skills.sh"`) writes to a marketplace root under
# $CODEX_HOME/.tmp/marketplaces. A symlink at that ancestor would install a
# third-party marketplace inside the checkout, so the ancestor is gated here.
# Its other destination, $CODEX_HOME/config.toml, is a LEAF file rather than a
# directory, so MANAGED_TREES cannot express it — it gets its own guard below.
# BOTH the parent and the exact leaf. Gating an ancestor does NOT gate a leaf:
# a symlink at .tmp/marketplaces/karpathy-skills lives INSIDE the gated ancestor
# and still points wherever it likes, and the updater follows it. The leaf name
# is fixed (`MARKETPLACE_NAME="karpathy-skills"` in update-karpathy-skills.sh),
# so it can be named here. Every other MANAGED_TREES entry was re-checked for
# this same parent-versus-leaf mismatch — see the report.
KARPATHY_MARKETPLACES_PINNED="$CODEX_HOME/.tmp/marketplaces"
KARPATHY_MARKETPLACE_ROOT_PINNED="$CODEX_HOME/.tmp/marketplaces/karpathy-skills"
CODEX_CONFIG_PINNED="$CODEX_HOME/config.toml"
# Every link_file TARGET under the managed home. These are leaf files, so
# MANAGED_TREES cannot express them; assert_managed_leaves gates them before the
# first mutation. The agent-skill targets under $CODEX_HOME/skills come from a
# glob and cannot be listed here — link_file's own directory-branch check is
# what covers those.
MANAGED_LEAVES=("" "$CODEX_HOME/AGENTS.md" "$CODEX_HOME/RTK-codex.md" \
  "$CODEX_HOME/RTK.md" "$CODEX_HOME/hooks.json" "$CODEX_CONFIG_PINNED" \
  "$CODEX_HOME/active/rules/enforce-codex.js" \
  "$CODEX_HOME/scripts/update-karpathy-skills.sh" \
  "$CODEX_HOME/scripts/install-codex-skills.sh" \
  "$CODEX_HOME/scripts/rtk-codex-hook.js")
MANAGED_TREES=("" "$CODEX_HOME/scripts" "$CODEX_HOME/skills" \
  "$CODEX_HOME/plugins/cache" "$CODEX_HOME/active/rules" "$BACKUP_ROOT" \
  "$GSTACK_BACKUP_DIR_PINNED" "$CORTEX_STAGING_PINNED" \
  "$AGENTS_TARGET_SKILLS_PINNED" "$GSTACK_MIGRATED_DIR_PINNED" \
  "$KARPATHY_MARKETPLACES_PINNED" "$KARPATHY_MARKETPLACE_ROOT_PINNED" \
  "$MATTPOCOCK_CACHE_PINNED")

# --- shared link/backup policy -------------------------------------------
# Function bodies below are byte-identical to scripts/bootstrap-cursor.sh and
# are the same policy as scripts/bootstrap-claude.sh / install-codex-skills.sh.
# link_file has exactly three outcomes for whatever already occupies a target:
#   - a symlink already spelled exactly as this source, and resolving, is left
#     untouched — the idempotent re-run path, neither parked nor unlinked;
#   - a symlink proven to be a physical alias of this source is unlinked, under
#     the owner-approved exception documented at that branch;
#   - everything else that requires replacement is parked in a reserved slot,
#     and the new link takes its place.
# That alias branch is the only unlink link_file performs. No content comparison
# decides a removal, so there is no comparison to get wrong. Ports must set
# BACKUP_ROOT, SOURCE_ROOT, PROTECTED_TREES and MANAGED_TREES, and must provide
# physical_dir_exact (defined above, outside the shared block because SCRIPT_DIR
# needs it before this point in the file).

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

# Topology gate FIRST: `codex features list` below writes inside $CODEX_HOME, so
# a home overlapping the checkout would already have been mutated by the time a
# later gate fired. Nothing above this line touches the filesystem.
assert_managed_topology "$CODEX_HOME" "$BACKUP_ROOT"
assert_managed_leaves

# The config LEAF, checked here rather than in MANAGED_TREES because it is a
# file: update-karpathy-skills.sh appends a [marketplaces.*] stanza to it, and a
# symlink there would redirect that write into the checkout (or anywhere else).
# `-L` is tested alongside `-e` because `-e` follows the link, so a DANGLING
# symlink would otherwise look absent and be created through on first write.
# Not existing yet is fine — that is the normal fresh-machine case.
if [ -L "$CODEX_CONFIG_PINNED" ] \
  || { [ -e "$CODEX_CONFIG_PINNED" ] && [ ! -f "$CODEX_CONFIG_PINNED" ]; }; then
  echo "Refusing a Codex config that is a symlink or not a regular file: $CODEX_CONFIG_PINNED" >&2
  exit 1
fi
# …and a HARDLINK, which the test above lets through: a hardlink IS a regular
# file and IS not a symlink, so `-f` says yes and `-L` says no, while a later
# append mutates the shared inode — an inode that can live inside the checkout.
# Link count is the only thing that distinguishes it; there is no `test` operator
# for this, hence stat. BSD `-f %l` first, GNU `-c %h` as the fallback. An
# unreadable count fails CLOSED rather than assuming 1.
if [ -f "$CODEX_CONFIG_PINNED" ]; then
  # Each probe is captured and validated ON ITS OWN — same shape, and same
  # reason, as target_mode in scripts/bootstrap-opencode.sh. Chaining them in
  # one $( ) with `||` is the catalogued stdout-preservation trap: on GNU
  # coreutils `stat -f` means "file system status", so `stat -f %l` treats %l as
  # an OPERAND, prints a filesystem report and returns 1 — and `|| true` KEEPS
  # that stdout, so the fallback's "1" is appended to the garbage. The value
  # then matches nothing and every ordinary existing config on Linux is refused.
  #
  # Status alone is not sufficient and neither is content alone: GNU `stat -f`
  # can SUCCEED while printing a non-count, so each probe must both exit 0 AND
  # print decimal digits. A probe failing either test is discarded, not merged.
  #
  # `command stat` raises the bar without setting a boundary: an exported
  # `stat(){ printf 1; }` reported 1 for a file whose real link count was 2,
  # reopening the hardlink bypass this check exists to close, and the prefix
  # stops that particular shim. It does NOT stop a caller who also shims
  # `command` — see the SHADOWING CEILING at the top of this file.
  # `trap - ERR` inside each subshell because a failing probe is
  # EXPECTED here and `set -E` would otherwise propagate the trap into the
  # command substitution.
  codex_config_links="$(trap - ERR; command stat -f %l "$CODEX_CONFIG_PINNED" 2>/dev/null)" \
    || codex_config_links=""
  case "$codex_config_links" in ''|*[!0123456789]*) codex_config_links="" ;; esac
  if [ -z "$codex_config_links" ]; then
    codex_config_links="$(trap - ERR; command stat -c %h "$CODEX_CONFIG_PINNED" 2>/dev/null)" \
      || codex_config_links=""
    case "$codex_config_links" in ''|*[!0123456789]*) codex_config_links="" ;; esac
  fi
  # An undeterminable count fails CLOSED: empty is not "1".
  if [ "$codex_config_links" != "1" ]; then
    echo "Refusing a Codex config whose link count is ${codex_config_links:-undeterminable} (expected 1; a hardlink can alias a file inside the checkout): $CODEX_CONFIG_PINNED" >&2
    exit 1
  fi
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in PATH. Install/open Codex first, then rerun this script." >&2
  exit 1
fi

# The RTK probe below shells out to `codex features list`, and the CLI refuses
# to start when CODEX_HOME does not exist ("CODEX_HOME points to ..., but that
# path does not exist"). Creating the root here — after the CLI is known to be
# installed, before the first command that needs it — is what makes a fresh
# machine, or an overridden CODEX_HOME, bootstrappable at all.
mkdir -p "$CODEX_HOME"

if ! "$SCRIPT_DIR/verify-rtk-codex-hook.sh"; then
  echo "Automatic RTK rewriting is required for the Codex harness. Update Codex/RTK and retry." >&2
  exit 1
fi

mkdir -p "$CODEX_HOME" "$CODEX_HOME/scripts" "$CODEX_HOME/skills" "$CODEX_HOME/plugins/cache" "$CODEX_HOME/active/rules"

link_file "$REPO_ROOT/AGENTS.md" "$CODEX_HOME/AGENTS.md"
link_file "$REPO_ROOT/RTK-codex.md" "$CODEX_HOME/RTK-codex.md"
link_file "$REPO_ROOT/RTK-codex.md" "$CODEX_HOME/RTK.md"
link_file "$REPO_ROOT/codex/hooks.json" "$CODEX_HOME/hooks.json"
# Hook target path expected by codex/hooks.json — symlink enforce-codex.js
# into the Codex install root so the PreToolUse hook can find it.
link_file "$REPO_ROOT/active/rules/enforce-codex.js" "$CODEX_HOME/active/rules/enforce-codex.js"
link_file "$REPO_ROOT/scripts/update-karpathy-skills.sh" "$CODEX_HOME/scripts/update-karpathy-skills.sh"
link_file "$REPO_ROOT/scripts/install-codex-skills.sh" "$CODEX_HOME/scripts/install-codex-skills.sh"
link_file "$REPO_ROOT/scripts/rtk-codex-hook.js" "$CODEX_HOME/scripts/rtk-codex-hook.js"

# Pinned caveman v1.8.1 skills — symlink (not copy) so updates are tracked
if [ -d "$REPO_ROOT/codex/agent-skills" ]; then
  for skill_dir in "$REPO_ROOT/codex/agent-skills"/*/; do
    # Parameter expansion, not $(basename): the glob appends the trailing slash
    # and $( ) would eat a trailing newline in the directory's own name, which
    # would aim link_file at a source that does not exist.
    skill_name="${skill_dir%/}"
    skill_name="${skill_name##*/}"
    link_file "$REPO_ROOT/codex/agent-skills/$skill_name" "$CODEX_HOME/skills/$skill_name"
  done
fi

# Pin ALL of the delegate's destination roots. Each is environment-controlled
# inside the callee, and a hostile ambient value would otherwise survive the
# delegation and be honoured there. Passing them explicitly is what makes the
# MANAGED_TREES gate binding: the values gated are exactly the values the
# delegate receives, so nothing can slip past by arriving through the
# environment instead.
#
# CODEX_HOME is passed for the same reason even though the callee computes the
# same default: when it was not set in this script's own environment it is a
# plain shell variable, so the callee would re-derive it from $HOME rather than
# from the value this script gated. Passing it removes $HOME from the callee's
# destination derivation entirely (TARGET_SKILLS and STAGING_PARENT both hang
# off CODEX_HOME), so there is no second derivation left to reason about.
# GSTACK_REPO is pinned here too, for the different reason documented at
# GSTACK_REPO_PINNED above: it is a clone SOURCE URL, so MANAGED_TREES has no
# path to gate and refusing to inherit it is the only lever. The callee keeps
# its own default and still honours the variable on DIRECT invocation.
GSTACK_BACKUP_DIR="$GSTACK_BACKUP_DIR_PINNED" \
  AGENTS_TARGET_SKILLS="$AGENTS_TARGET_SKILLS_PINNED" \
  GSTACK_MIGRATED_DIR="$GSTACK_MIGRATED_DIR_PINNED" \
  CODEX_HOME="$CODEX_HOME" \
  GSTACK_REPO="$GSTACK_REPO_PINNED" \
  GSTACK_STATE_ROOT="$GSTACK_STATE_HOME_PINNED" \
  GSTACK_HOME="$GSTACK_STATE_HOME_PINNED" \
  GSTACK_STATE_DIR="$GSTACK_STATE_HOME_PINNED" \
  "$REPO_ROOT/scripts/install-codex-skills.sh"

# mattpocock skills (github.com/mattpocock/skills, MIT) — best-effort, non-fatal.
# Runs AFTER install-codex-skills.sh (which links the cortex's own promoted
# skills) so a clone/network failure here can never prevent those.
INSTALL_MATTPOCOCK="${INSTALL_MATTPOCOCK:-1}"
if [ "$INSTALL_MATTPOCOCK" = "1" ] && [ -x "$SCRIPT_DIR/install-mattpocock-skills.sh" ]; then
  # MATTPOCOCK_CACHE passed explicitly, for the same reason as the other five
  # delegated destinations: gated above, so an ambient value cannot be
  # inherited. The direct-installer override survives — running
  # install-mattpocock-skills.sh yourself still honours the variable.
  MATTPOCOCK_CACHE="$MATTPOCOCK_CACHE_PINNED" \
    "$SCRIPT_DIR/install-mattpocock-skills.sh" "$CODEX_HOME/skills" \
    || echo "warn: mattpocock skills install failed (optional, non-fatal); continuing." >&2
fi

if [ "${SETUP_GRAPHIFY_BRAIN:-1}" = "1" ]; then
  "$SCRIPT_DIR/setup-graphify-brain.sh" --codex \
    || echo "warn: Graphify Brain not configured; clone the private Brain and rerun this bootstrap." >&2
fi

echo "Codex bootstrap complete."
echo "Cortex root: $REPO_ROOT"
echo "Codex home: $CODEX_HOME"
echo "Restart Codex to load updated AGENTS, skills, and plugins."
echo "Then open /hooks and trust the current user hook definitions."
