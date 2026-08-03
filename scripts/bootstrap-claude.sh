#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CLAUDE_BACKUP_DIR="${CLAUDE_BACKUP_DIR:-$CLAUDE_HOME/backups}"

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
  cd -P -- "$1" 2>/dev/null && pwd -P
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
  # dirname/basename below go through $( ), which eats trailing newlines. No
  # canonical spelling of our own source contains one, so a newline-bearing
  # value is never ours — reject it here instead of comparing it truncated.
  case "$raw" in
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
  target_dir="$(dirname "$target")"
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
    backup_target "$target" "directory"
  elif [ -e "$target" ]; then
    backup_target "$target" "file"
  fi

  ln -s "$source" "$target"
}

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
