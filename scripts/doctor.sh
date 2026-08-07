#!/usr/bin/env bash
# scripts/doctor.sh — read-only cross-harness health check for the Jarvis cortex.
#
# Run after install on any machine to verify the cortex is wired correctly
# across harnesses (Claude Code app+CLI, Codex, opencode, Cursor). Catches the
# cold-install breakages: dangling symlinks, settings.json hooks/statusLine
# pointing at missing files, enabled-but-unsourced plugins, missing Graphify
# Brain/MCP wiring, dangling Codex links, or stale OpenCode/Cursor configs.
#
# READ-ONLY: never creates, modifies, or deletes anything.
#
# Honors HOME / CLAUDE_HOME / CODEX_HOME / CURSOR_HOME overrides so it can run
# against a throwaway test HOME. Derives the cortex root from this script's
# location, exactly like the bootstraps.
#
# Exit 0 when healthy (only OK/WARN). Exit 1 if any FAIL.

set -uo pipefail

# Keep every provenance comparison on the physical checkout path. This is
# essential when doctor is invoked through ~/.codex/jarvis-cortex -> checkout.
SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P -- "$SCRIPT_DIR/.." && pwd -P)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
GSTACK_REPO_ROOT="${GSTACK_REPO_ROOT:-$HOME/.gstack/repos/gstack}"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.jsonc"
RTK_BIN="${1:-rtk}"
CODEX_BIN="${2:-codex}"
JARVIS_BRAIN_OPTIONAL="${JARVIS_BRAIN_OPTIONAL:-0}"
CURSOR_MANIFEST_TOOL="${CURSOR_MANIFEST_TOOL:-$REPO_ROOT/scripts/cursor-skill-manifest.mjs}"
CURSOR_COPY_TOOL="$REPO_ROOT/scripts/cursor-skill-copy.mjs"
CURSOR_GSTACK_TOOL="$REPO_ROOT/scripts/cursor-gstack-install.mjs"
CURSOR_AUDIT_TOOL="$REPO_ROOT/scripts/cursor-skills-audit.mjs"
CURSOR_ROOT_GUARD="$REPO_ROOT/scripts/cursor-root-guard.mjs"
CURSOR_LINK_TARGET_TOOL="$REPO_ROOT/scripts/cursor-link-target.mjs"
CURSOR_MANAGED_MANIFEST="$CURSOR_HOME/jarvis-cortex-skills.manifest.tsv"
CURSOR_MCP_TEMPLATE="$REPO_ROOT/cursor/mcp.json"
. "$REPO_ROOT/scripts/cursor-third-party.sh"

OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
FAIL_HINTS=()

ok()   { printf '  OK    %s\n' "$1"; OK_COUNT=$((OK_COUNT + 1)); }
warn() { printf '  WARN  %s\n' "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
fail() {
  printf '  FAIL  %s\n' "$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  [ -n "${2:-}" ] && FAIL_HINTS+=("$1 — $2")
}
group() { printf '\n%s\n' "$1"; }

# Dangling = symlink whose target does not resolve.
is_dangling() { [ -L "$1" ] && [ ! -e "$1" ]; }

resolve_path() {
  [ "$HAVE_NODE" -eq 1 ] || return 1
  node -e '
    const fs = require("fs");
    try {
      process.stdout.write(fs.realpathSync(process.argv[1]));
    } catch {
      process.exit(1);
    }
  ' "$1" 2>/dev/null
}

is_exact_link_target() {
  [ "$HAVE_NODE" -eq 1 ] || return 1
  node "$CURSOR_LINK_TARGET_TOOL" verify "$1" "$2" 2>/dev/null || return 1
  node -e '
    const fs = require("fs");
    const [target, source] = process.argv.slice(1);
    try {
      const sourceReal = fs.realpathSync(source);
      process.exit(sourceReal === source && fs.realpathSync(target) === sourceReal ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$1" "$2" 2>/dev/null
}

require_resolved_path() {
  label="$1"
  target="$2"
  hint="$3"
  expected="${4:-}"

  if is_dangling "$target"; then
    fail "dangling symlink: $target" "$hint"
    return 1
  fi
  if [ ! -e "$target" ]; then
    fail "$label missing: $target" "$hint"
    return 1
  fi
  if [ -n "$expected" ] && [ "$HAVE_NODE" -eq 1 ]; then
    actual_real="$(resolve_path "$target" || true)"
    expected_real="$(resolve_path "$expected" || true)"
    if [ -n "$actual_real" ] && [ -n "$expected_real" ] && [ "$actual_real" != "$expected_real" ]; then
      fail "$label points at unexpected target: $target -> $actual_real" "$hint"
      return 1
    fi
  fi
  ok "$label resolves ($target)"
  return 0
}

# ---------------------------------------------------------------------------
group "GENERAL"

if command -v node >/dev/null 2>&1; then
  ok "node on PATH ($(command -v node))"
else
  fail "node not on PATH" "install Node.js — node is a hard dependency (JSON parsing, tests)"
fi

command -v "$RTK_BIN" >/dev/null 2>&1 && ok "rtk available" || warn "rtk not available — RTK is required per cortex rules; install it"
command -v git     >/dev/null 2>&1 && ok "git on PATH"     || warn "git not on PATH"
command -v "$CODEX_BIN" >/dev/null 2>&1 && ok "codex available" || warn "codex not available — only needed for the Codex harness + loop-hermes re-review"
command -v graphify >/dev/null 2>&1 && ok "graphify available" || warn "graphify not on PATH"
command -v graphify-mcp >/dev/null 2>&1 && ok "graphify-mcp available" || warn "graphify-mcp not on PATH"
if command -v pxpipe >/dev/null 2>&1; then
  pxpipe_pkg_version=""
  if command -v npm >/dev/null 2>&1; then
    pxpipe_pkg_version="$(npm ls -g pxpipe-proxy --depth=0 2>/dev/null | sed -n 's/.*pxpipe-proxy@//p' | head -n 1 || true)"
  fi
  if [ -n "$pxpipe_pkg_version" ]; then
    ok "pxpipe on PATH ($(command -v pxpipe); pxpipe-proxy@$pxpipe_pkg_version)"
  else
    ok "pxpipe on PATH ($(command -v pxpipe))"
  fi
  ok "pxpipe policy is Claude-only; Codex runs without the proxy"
else
  warn "pxpipe not on PATH — optional token-saving proxy; run scripts/install-pxpipe.sh"
fi

if [ -f "$REPO_ROOT/JARVIS.md" ] && [ -f "$REPO_ROOT/BOOT.md" ]; then
  ok "cortex root resolves ($REPO_ROOT)"
else
  fail "cortex root does not look like the cortex ($REPO_ROOT)" "run doctor.sh from the cloned cortex's scripts/ dir"
fi

HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1

# ---------------------------------------------------------------------------
group "GRAPHIFY BRAIN"

resolve_brain_home() {
  if [ -n "${JARVIS_BRAIN_HOME:-}" ]; then
    BRAIN_HOME="$JARVIS_BRAIN_HOME"
    return
  fi
  config_path="${JARVIS_CORTEX_CONFIG:-$CLAUDE_HOME/config.json}"
  if [ -f "$config_path" ]; then
    if [ "$HAVE_NODE" -ne 1 ]; then
      fail "cannot validate Cortex config without node ($config_path)" "install Node.js"
      return 1
    fi
    if ! configured="$(node "$SCRIPT_DIR/graphify-brain-config.js" config-path "$config_path" 2>/dev/null)"; then
      fail "Cortex config is invalid ($config_path)" "repair graphifyBrainPath or the JSON syntax"
      return 1
    fi
    if [ -n "$configured" ]; then
      configured="${configured/#\~/$HOME}"
      BRAIN_HOME="$configured"
      return
    fi
  fi
  BRAIN_HOME="$HOME/.jarvis/brain"
}

BRAIN_HOME=""
GRAPHIFY_MCP_BIN="$(command -v graphify-mcp 2>/dev/null || true)"
if ! resolve_brain_home; then
  BRAIN_GRAPH=""
else
  BRAIN_GRAPH="$BRAIN_HOME/graphify-out/graph.json"
  if ! git -C "$BRAIN_HOME" rev-parse --git-dir >/dev/null 2>&1; then
    if [ "$JARVIS_BRAIN_OPTIONAL" = "1" ]; then
      warn "Jarvis Brain not installed ($BRAIN_HOME)"
    else
      fail "Jarvis Brain repository missing ($BRAIN_HOME)" "clone the private Brain or set JARVIS_BRAIN_HOME"
    fi
  elif [ ! -s "$BRAIN_GRAPH" ]; then
    fail "Jarvis Brain graph missing or empty ($BRAIN_GRAPH)" "run the Graphify skill from the Brain root"
  else
    if [ "$HAVE_NODE" -eq 1 ] && node "$SCRIPT_DIR/graphify-brain-config.js" validate-graph "$BRAIN_GRAPH" >/dev/null 2>&1; then
      graph_stats="$(node "$SCRIPT_DIR/graphify-brain-config.js" validate-graph "$BRAIN_GRAPH")"
      ok "Jarvis Brain graph parses ($graph_stats)"
    else
      fail "Jarvis Brain graph is invalid ($BRAIN_GRAPH)" "rebuild it with the Graphify skill"
    fi

    if command -v graphify >/dev/null 2>&1; then
      if ! hook_status="$(cd "$BRAIN_HOME" && graphify hook status 2>/dev/null)"; then
        fail "Graphify Git-hook status check failed in Markdown Brain" "run graphify hook status from the Brain root"
      elif [ "$hook_status" = $'post-commit: not installed\npost-checkout: not installed' ]; then
        ok "Graphify code-only Git hooks are disabled in the Brain"
      else
        fail "Graphify Git hooks are installed or their status is unrecognized" "run graphify hook uninstall and verify both hooks"
      fi
      if graphify explain "Jarvis Brain" --graph "$BRAIN_GRAPH" 2>/dev/null | grep -q '^Node: Jarvis Brain'; then
        ok "Graphify CLI resolves the Jarvis Brain node"
      else
        fail "Graphify CLI cannot resolve the Jarvis Brain node" "rebuild the semantic graph"
      fi
    else
      fail "graphify CLI missing" "install the validated graphifyy runtime"
    fi

    if [ -n "$GRAPHIFY_MCP_BIN" ]; then
      # NOT `--help`: that exits 0 without building the server, so it passed
      # while graphify-mcp was crashing on an incompatible mcp package. This
      # speaks the protocol instead — see probe-mcp in graphify-brain-config.js.
      node "$SCRIPT_DIR/graphify-brain-config.js" probe-mcp "$GRAPHIFY_MCP_BIN" "$BRAIN_GRAPH" >/dev/null 2>&1 \
        && ok "graphify-mcp answers the MCP handshake" \
        || fail "graphify-mcp does not answer the MCP handshake" "reinstall: uv tool install --python 3.12 \"graphifyy[mcp,openai]==0.9.11\" --with \"mcp<2\" --force"
    else
      fail "graphify-mcp missing" "install graphifyy with the mcp extra"
    fi

    if command -v "$CODEX_BIN" >/dev/null 2>&1; then
      if codex_mcp="$("$CODEX_BIN" mcp get graphify-brain --json 2>/dev/null)" \
        && [ -n "$codex_mcp" ] \
        && printf '%s' "$codex_mcp" \
          | node "$SCRIPT_DIR/graphify-brain-config.js" \
            validate-codex-mcp "$GRAPHIFY_MCP_BIN" "$BRAIN_GRAPH" >/dev/null 2>&1; then
        ok "Codex graphify-brain MCP targets the canonical graph"
      else
        fail "Codex graphify-brain MCP missing or misconfigured" "run scripts/setup-graphify-brain.sh --codex"
      fi
    else
      warn "codex CLI missing — cannot verify graphify-brain MCP registration"
    fi

    if command -v claude >/dev/null 2>&1; then
      if claude_mcp="$(claude mcp get graphify-brain 2>/dev/null)" \
        && printf '%s' "$claude_mcp" \
          | node "$SCRIPT_DIR/graphify-brain-config.js" \
            validate-claude-mcp "$GRAPHIFY_MCP_BIN" "$BRAIN_GRAPH" >/dev/null 2>&1; then
        ok "Claude Code graphify-brain MCP targets the canonical graph"
      else
        fail "Claude Code graphify-brain MCP missing, unreachable, or misconfigured" "run scripts/setup-graphify-brain.sh --claude"
      fi
    else
      warn "claude CLI missing — cannot verify graphify-brain MCP registration"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# CLAUDE harness
if [ -d "$CLAUDE_HOME" ]; then
  group "CLAUDE harness ($CLAUDE_HOME)"

  # 1. Dangling symlinks for the explicit cortex-managed entries only.
  managed=(BOOT.md CLAUDE.md JARVIS.md RTK.md active commands docs memory scripts \
           skills/dead-code-audit skills/impeccable skills/loop-hermes skills/orchestrate skills/security-audit \
           skills/strategic-compact skills/verification-loop skills/jarvis-learn)
  if [ -f "$REPO_ROOT/active/claude-agents/impeccable-manual-edit-applier.md" ]; then
    managed+=(agents/impeccable-manual-edit-applier.md)
  fi
  dangling_found=0
  for entry in "${managed[@]}"; do
    if is_dangling "$CLAUDE_HOME/$entry"; then
      fail "dangling symlink: $CLAUDE_HOME/$entry" "re-run scripts/bootstrap-claude.sh from the current cortex root"
      dangling_found=1
    fi
  done
  [ "$dangling_found" -eq 0 ] && ok "no dangling cortex symlinks under \$CLAUDE_HOME"

  require_resolved_path \
    "Claude Impeccable skill" \
    "$CLAUDE_HOME/skills/impeccable" \
    "re-run scripts/bootstrap-claude.sh from the current cortex root" \
    "$REPO_ROOT/active/claude-skills/impeccable"
  if [ -f "$REPO_ROOT/active/claude-agents/impeccable-manual-edit-applier.md" ]; then
    require_resolved_path \
      "Claude Impeccable helper agent" \
      "$CLAUDE_HOME/agents/impeccable-manual-edit-applier.md" \
      "re-run scripts/bootstrap-claude.sh from the current cortex root" \
      "$REPO_ROOT/active/claude-agents/impeccable-manual-edit-applier.md"
  fi

  # 2. settings.json: hook commands + statusLine reference existing files.
  settings="$CLAUDE_HOME/settings.json"
  if [ ! -e "$settings" ]; then
    fail "settings.json missing ($settings)" "re-run scripts/bootstrap-claude.sh"
  elif [ "$HAVE_NODE" -eq 0 ]; then
    warn "settings.json present but node missing — cannot parse hook/statusLine paths"
  else
    # node emits: <kind>\t<expanded-path>  where kind = hook | statusline.
    # Only entries that resolve to a local file path are emitted; bare binaries
    # (e.g. `rtk hook claude`) are skipped (PATH check covers them).
    parsed="$(HOME="$HOME" CLAUDE_HOME="$CLAUDE_HOME" node -e '
      const fs = require("fs");
      const HOME = process.env.HOME, CH = process.env.CLAUDE_HOME;
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const out = [];
      const expand = (p) => p.split("$CLAUDE_HOME").join(CH).split("${CLAUDE_HOME}").join(CH)
                             .split("$HOME").join(HOME).split("${HOME}").join(HOME);
      // Pull the file path out of an interpreter command like: node "..." / bash "..."
      function pathOf(cmd) {
        if (!cmd) return null;
        const toks = cmd.match(/"[^"]+"|\S+/g) || [];
        const bin = (toks[0] || "").replace(/^"|"$/g, "");
        if (!/(^|\/)(node|bash|sh|python3?)$/.test(bin)) return null; // bare binary → skip
        for (let i = 1; i < toks.length; i++) {
          const a = toks[i].replace(/^"|"$/g, "");
          if (a.startsWith("-")) continue;
          return expand(a);
        }
        return null;
      }
      const hooks = s.hooks || {};
      for (const event of Object.keys(hooks)) {
        for (const grp of hooks[event] || []) {
          for (const h of grp.hooks || []) {
            const p = pathOf(h.command);
            if (p) out.push("hook\t" + p);
          }
        }
      }
      if (s.statusLine && s.statusLine.command) {
        const p = pathOf(s.statusLine.command);
        if (p) out.push("statusline\t" + p);
      }
      process.stdout.write(out.join("\n"));
    ' "$settings" 2>/dev/null)"
    parse_rc=$?  # capture immediately; any later command would clobber $?
    settings_valid=1
    if [ "$parse_rc" -ne 0 ]; then
      fail "settings.json is not valid JSON ($settings)" "fix the JSON syntax in settings.json"
      settings_valid=0
    else
      hooks_ok=1
      while IFS=$'\t' read -r kind path; do
        [ -z "${kind:-}" ] && continue
        if [ -e "$path" ]; then
          continue
        fi
        if [ "$kind" = "statusline" ]; then
          # statusLine is cosmetic + caveman-deferred; bootstrap skips it until
          # caveman is installed. Missing → WARN, never blocks a cold install.
          warn "statusLine command target missing: $path (install caveman, then re-run bootstrap-claude.sh)"
        else
          fail "hook command target missing: $path" "re-run scripts/bootstrap-claude.sh (cortex-managed hook file is absent)"
          hooks_ok=0
        fi
      done <<< "$parsed"
      [ "$hooks_ok" -eq 1 ] && ok "settings.json hook commands resolve"
    fi

    # Sections 3-4 read settings.json again; skip them when it is malformed
    # (fail-closed: avoid a misleading OK next to the JSON FAIL above).
    if [ "$settings_valid" -eq 1 ]; then
    # 3. enabledPlugins: each must be sourced (marketplace registered OR cached).
    plugins="$(node -e '
      const fs = require("fs");
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const en = s.enabledPlugins || {};
      const mk = Object.keys(s.extraKnownMarketplaces || {});
      for (const key of Object.keys(en)) {
        if (en[key] !== true) continue;
        const market = key.includes("@") ? key.split("@").pop() : "";
        process.stdout.write(key + "\t" + market + "\t" + (mk.includes(market) ? "1" : "0") + "\n");
      }
    ' "$settings" 2>/dev/null)"
    plugins_ok=1
    while IFS=$'\t' read -r key market registered; do
      [ -z "${key:-}" ] && continue
      cached=0
      [ -n "$market" ] && [ -d "$CLAUDE_HOME/plugins/cache/$market" ] && cached=1
      if [ "$registered" = "1" ] || [ "$cached" -eq 1 ]; then
        continue
      fi
      fail "plugin '$key' enabled but has no source (marketplace not registered, not cached)" \
           "add '$market' to extraKnownMarketplaces in settings.json, or it cannot auto-install"
      plugins_ok=0
    done <<< "$plugins"
    [ "$plugins_ok" -eq 1 ] && ok "enabledPlugins are all sourced (marketplace registered or cached)"

    fi  # settings_valid
  fi
else
  group "CLAUDE harness"
  warn "\$CLAUDE_HOME not found ($CLAUDE_HOME) — Claude Code not set up on this machine"
fi

# ---------------------------------------------------------------------------
# CODEX harness
if [ -d "$CODEX_HOME" ]; then
  group "CODEX harness ($CODEX_HOME)"
  codex_ok=1
  for entry in AGENTS.md RTK.md hooks.json skills/impeccable; do
    if is_dangling "$CODEX_HOME/$entry"; then
      fail "dangling symlink: $CODEX_HOME/$entry" "re-run scripts/bootstrap-codex.sh from the current cortex root"
      codex_ok=0
    elif [ ! -e "$CODEX_HOME/$entry" ]; then
      fail "Codex managed entry missing: $CODEX_HOME/$entry" "re-run scripts/bootstrap-codex.sh from the current cortex root"
      codex_ok=0
    fi
  done
  require_resolved_path \
    "Codex RTK adapter" \
    "$CODEX_HOME/scripts/rtk-codex-hook.js" \
    "re-run scripts/bootstrap-codex.sh from the current cortex root" \
    "$REPO_ROOT/scripts/rtk-codex-hook.js" || codex_ok=0
  require_resolved_path \
    "Codex Impeccable skill" \
    "$CODEX_HOME/skills/impeccable" \
    "re-run scripts/install-codex-skills.sh from the current cortex root" \
    "$REPO_ROOT/active/skills/impeccable" || codex_ok=0
  [ "$codex_ok" -eq 1 ] && ok "Codex managed links, including the RTK adapter, resolve"
  if [ -f "$CODEX_HOME/hooks.json" ] && [ "$HAVE_NODE" -eq 1 ]; then
    if node -e '
      const fs = require("fs");
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const groups = manifest.hooks?.PreToolUse || [];
      const valid = groups.some((group) =>
        group.matcher === "Bash" &&
        (group.hooks || []).some((hook) =>
          hook.type === "command" && hook.command === "node \"$HOME/.codex/scripts/rtk-codex-hook.js\""
        )
      );
      process.exit(valid ? 0 : 1);
    ' "$CODEX_HOME/hooks.json" 2>/dev/null; then
      ok "Codex Bash PreToolUse includes automatic RTK rewrite"
    else
      fail "Codex automatic RTK hook missing or invalid" "re-run scripts/bootstrap-codex.sh from the current cortex root"
    fi
  fi
  if "$REPO_ROOT/scripts/verify-rtk-codex-hook.sh" \
    "$CODEX_HOME/scripts/rtk-codex-hook.js" "$RTK_BIN" "$CODEX_BIN" >/dev/null 2>&1; then
    ok "Codex hooks feature and RTK adapter contract probe pass"
  else
    fail "Codex hooks or RTK rewrite probe failed" "update Codex/RTK, then re-run scripts/bootstrap-codex.sh"
  fi
  agents_home="${AGENTS_TARGET_SKILLS:-$HOME/.agents/skills}"
  require_resolved_path \
    "Agents global Impeccable skill" \
    "$agents_home/impeccable" \
    "re-run scripts/install-codex-skills.sh so Codex hook commands work from any project" \
    "$REPO_ROOT/active/skills/impeccable"
  if [ -d "$CODEX_HOME/skills" ]; then
    backup_skill_count="$(find "$CODEX_HOME/skills" -path '*backup*' -name SKILL.md -type f 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${backup_skill_count:-0}" -gt 0 ]; then
      warn "backup skill trees under $CODEX_HOME/skills may be discovered by Codex ($backup_skill_count SKILL.md); move backups outside skills/"
    else
      ok "no backup skill trees under Codex skills"
    fi
  fi
else
  group "CODEX harness"
  warn "\$CODEX_HOME not found ($CODEX_HOME) — Codex not set up on this machine"
fi

# ---------------------------------------------------------------------------
# OPENCODE harness
if [ -f "$OPENCODE_CONFIG" ]; then
  group "OPENCODE harness ($OPENCODE_CONFIG)"
  if [ "$HAVE_NODE" -eq 0 ]; then
    warn "opencode config present but node missing — cannot parse instructions"
  else
    # JSONC: strip ONLY full-line // comments (jarvis-managed markers etc).
    # Never strip inline // — it would corrupt URLs like https://...
    # One parse, type-prefixed lines (instr|skill|venv), so malformed JSONC
    # stays a SINGLE fail-closed surface (no stray OK/WARN beside the FAIL).
    parsed="$(HOME="$HOME" node -e '
      const fs = require("fs");
      const HOME = process.env.HOME;
      const raw = fs.readFileSync(process.argv[1], "utf8");
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
      const s = JSON.parse(stripped);
      const expand = (p) => p.split("$HOME").join(HOME).split("${HOME}").join(HOME);
      for (const p of (s.instructions || [])) process.stdout.write("instr\t" + expand(p) + "\n");
      const sk = (s.skills || {}).paths || [];
      for (const p of sk) process.stdout.write("skill\t" + expand(p) + "\n");
    ' "$OPENCODE_CONFIG" 2>/dev/null)"
    if [ $? -ne 0 ]; then
      fail "opencode.jsonc is not parseable ($OPENCODE_CONFIG)" "re-run scripts/bootstrap-opencode.sh"
    else
      instr_ok=1
      skills_ok=1
      while IFS=$'\t' read -r kind path; do
        [ -z "${kind:-}" ] && continue
        case "$kind" in
          instr)
            if [ ! -e "$path" ]; then
              fail "opencode instructions path missing: $path" "re-run scripts/bootstrap-opencode.sh from the current cortex root"
              instr_ok=0
            fi
            ;;
          skill)
            # opencode tolerates missing skill dirs → WARN, never FAIL.
            if [ ! -e "$path" ]; then
              warn "opencode skills.paths entry missing: $path (re-run scripts/bootstrap-opencode.sh, or it is simply absent on this HOME)"
              skills_ok=0
            fi
            ;;
        esac
      done <<< "$parsed"
      [ "$instr_ok" -eq 1 ] && ok "opencode instructions paths resolve"
      [ "$skills_ok" -eq 1 ] && ok "opencode skills.paths resolve"
    fi
  fi
else
  group "OPENCODE harness"
  warn "opencode config not found ($OPENCODE_CONFIG) — opencode not set up on this machine"
fi

# ---------------------------------------------------------------------------
# CURSOR harness
# Detect jarvis Cursor harness ONLY via jarvis signals — not any personal
# ~/.cursor/mcp.json or hooks.json (those are common without jarvis).
CURSOR_HOOKS_JSON="$CURSOR_HOME/hooks.json"
CURSOR_MCP_JSON="$CURSOR_HOME/mcp.json"
CURSOR_PERMISSIONS_JSON="$CURSOR_HOME/permissions.json"
CURSOR_RULE="$CURSOR_HOME/rules/jarvis-cortex.mdc"

# Detect partial/stale installs fail-closed. Generic Cursor config files alone
# are not evidence of Jarvis; every signal below is a Jarvis-owned filename,
# marker, runtime path, or exact config entry.
cursor_has_managed_manifest=0
if [ -e "$CURSOR_MANAGED_MANIFEST" ] || [ -L "$CURSOR_MANAGED_MANIFEST" ]; then
  cursor_has_managed_manifest=1
fi

cursor_has_fixed_wiring=0
for cursor_fixed_path in \
  "$CURSOR_HOME/hooks/session-start.js" \
  "$CURSOR_HOME/hooks/rtk-shell.js" \
  "$CURSOR_HOME/hooks/enforce-cursor.js" \
  "$CURSOR_PERMISSIONS_JSON"; do
  # Bootstrap owns these as symlinks. A regular personal file at the same
  # generic permissions path is deliberately not enough to detect Jarvis.
  if [ -L "$cursor_fixed_path" ]; then
    cursor_has_fixed_wiring=1
    break
  fi
done

cursor_has_runtime=0
for cursor_runtime_path in \
  "$CURSOR_HOME/jarvis-runtime" \
  "$CURSOR_HOME/jarvis-runtime/gstack" \
  "$CURSOR_HOME/jarvis-runtime/gstack-state" \
  "$CURSOR_HOME/jarvis-runtime/gstack/.jarvis-cortex-runtime.json" \
  "$CURSOR_HOME/jarvis-runtime/gstack-state/.jarvis-cortex-state.json"; do
  if [ -e "$cursor_runtime_path" ] || [ -L "$cursor_runtime_path" ]; then
    cursor_has_runtime=1
    break
  fi
done

cursor_has_managed_skill_marker=0
if [ -d "$CURSOR_HOME/skills" ]; then
  cursor_managed_skill_marker="$(find "$CURSOR_HOME/skills" \
    -name .jarvis-cortex-skill.json -print -quit 2>/dev/null || true)"
  [ -n "$cursor_managed_skill_marker" ] && cursor_has_managed_skill_marker=1
fi

cursor_has_jarvis_rule=0
# Count dangling symlink as a jarvis signal so doctor FAILs it (not WARN absent).
if [ -e "$CURSOR_RULE" ] || [ -L "$CURSOR_RULE" ]; then
  cursor_has_jarvis_rule=1
fi

cursor_has_jarvis_hooks=0
if [ -f "$CURSOR_HOOKS_JSON" ] && [ ! -L "$CURSOR_HOOKS_JSON" ] \
  && [ "$HAVE_NODE" -eq 1 ]; then
  if node -e '
    const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks || {};
    const jarvis = new Set([
      "./hooks/session-start.js",
      "./hooks/rtk-shell.js",
      "./hooks/enforce-cursor.js",
    ]);
    for (const list of Object.values(h)) {
      for (const item of (list || [])) {
        if (item && jarvis.has(item.command)) process.exit(0);
      }
    }
    process.exit(1);
  ' "$CURSOR_HOOKS_JSON" 2>/dev/null; then
    cursor_has_jarvis_hooks=1
  fi
fi

cursor_has_graphify=0
cursor_graphify_status="unavailable"
if [ -f "$CURSOR_MCP_JSON" ] && [ ! -L "$CURSOR_MCP_JSON" ] \
  && [ "$HAVE_NODE" -eq 1 ]; then
  cursor_graphify_status="$(node -e '
    const fs = require("fs");
    const { isDeepStrictEqual } = require("util");
    let expected;
    try {
      expected = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
        ?.mcpServers?.["graphify-brain"];
    } catch {
      process.stdout.write("template-invalid");
      process.exit(0);
    }
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      process.stdout.write("template-invalid");
      process.exit(0);
    }
    let installed;
    try {
      installed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch {
      process.stdout.write("malformed");
      process.exit(0);
    }
    const actual = installed?.mcpServers?.["graphify-brain"];
    if (actual === undefined) process.stdout.write("missing");
    else if (isDeepStrictEqual(actual, expected)) process.stdout.write("valid");
    else process.stdout.write("misconfigured");
  ' "$CURSOR_MCP_JSON" "$CURSOR_MCP_TEMPLATE" 2>/dev/null || printf 'validator-error')"
  [ "$cursor_graphify_status" = "valid" ] && cursor_has_graphify=1
fi

if [ "$cursor_has_jarvis_rule" -eq 1 ] \
  || [ "$cursor_has_jarvis_hooks" -eq 1 ] \
  || [ "$cursor_has_graphify" -eq 1 ] \
  || [ "$cursor_has_managed_manifest" -eq 1 ] \
  || [ "$cursor_has_fixed_wiring" -eq 1 ] \
  || [ "$cursor_has_runtime" -eq 1 ] \
  || [ "$cursor_has_managed_skill_marker" -eq 1 ]; then
  group "CURSOR harness ($CURSOR_HOME)"
  cursor_ok=1
  if [ "$HAVE_NODE" -eq 0 ]; then
    fail "Cursor harness detected but Node.js is unavailable" "install Node.js and re-run doctor; Cursor JSON, ownership, and provenance checks are mandatory"
    cursor_ok=0

    cursor_shell_roots_safe=1
    for cursor_managed_root in \
      "$CURSOR_HOME" \
      "$CURSOR_HOME/hooks" \
      "$CURSOR_HOME/rules" \
      "$CURSOR_HOME/skills" \
      "$CURSOR_HOME/jarvis-runtime"; do
      if [ -L "$cursor_managed_root" ]; then
        fail "Cursor managed root is a symlink and cannot be trusted without Node.js: $cursor_managed_root" "replace it with a current-user-owned real directory, restore Node.js, and re-run bootstrap"
        cursor_shell_roots_safe=0
        cursor_ok=0
      elif [ ! -d "$cursor_managed_root" ]; then
        fail "Cursor managed root missing: $cursor_managed_root" "re-run scripts/bootstrap-cursor.sh"
        cursor_shell_roots_safe=0
        cursor_ok=0
      fi
    done
    [ "$cursor_shell_roots_safe" -eq 1 ] \
      && ok "Cursor managed roots are real directories (shell fallback)"

    if [ -f "$CURSOR_HOOKS_JSON" ] && [ ! -L "$CURSOR_HOOKS_JSON" ]; then
      cursor_shell_hooks_ok=1
      for cursor_required_hook in \
        './hooks/session-start.js' \
        './hooks/rtk-shell.js' \
        './hooks/enforce-cursor.js'; do
        if ! grep -Fq "$cursor_required_hook" "$CURSOR_HOOKS_JSON" 2>/dev/null; then
          fail "Cursor hooks.json missing jarvis command: $cursor_required_hook" "restore Node.js and re-run scripts/bootstrap-cursor.sh"
          cursor_shell_hooks_ok=0
          cursor_ok=0
        fi
      done
      [ "$cursor_shell_hooks_ok" -eq 1 ] \
        && ok "Cursor hooks.json contains Jarvis commands (shell fallback)"
    else
      fail "Cursor hooks.json missing or unsafe ($CURSOR_HOOKS_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    for cursor_required_target in \
      "$CURSOR_HOME/hooks/session-start.js" \
      "$CURSOR_HOME/hooks/rtk-shell.js" \
      "$CURSOR_HOME/hooks/enforce-cursor.js"; do
      if is_dangling "$cursor_required_target" || [ ! -e "$cursor_required_target" ]; then
        fail "Cursor hook target missing: $cursor_required_target" "re-run scripts/bootstrap-cursor.sh from the current cortex root"
        cursor_ok=0
      fi
    done

    if [ ! -e "$CURSOR_PERMISSIONS_JSON" ] || is_dangling "$CURSOR_PERMISSIONS_JSON"; then
      fail "Cursor permissions missing or dangling ($CURSOR_PERMISSIONS_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ -f "$CURSOR_MCP_JSON" ] && [ ! -L "$CURSOR_MCP_JSON" ]; then
      fail "Cursor mcp.json cannot be verified without Node.js ($CURSOR_MCP_JSON)" "restore Node.js and re-run doctor; text matching is not accepted as MCP provenance"
      cursor_ok=0
    else
      fail "Cursor mcp.json missing or unsafe ($CURSOR_MCP_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if is_dangling "$CURSOR_RULE" || [ ! -e "$CURSOR_RULE" ]; then
      fail "Cursor jarvis-cortex rule missing or dangling ($CURSOR_RULE)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ ! -f "$CURSOR_MANAGED_MANIFEST" ] || [ -L "$CURSOR_MANAGED_MANIFEST" ]; then
      fail "Cursor installed skill manifest missing or not a regular file ($CURSOR_MANAGED_MANIFEST)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi
  else
    cursor_skills_root_safe=1
    cursor_manifest_status=0
    cursor_manifest="$(node "$CURSOR_MANIFEST_TOOL" "$REPO_ROOT" "$GSTACK_REPO_ROOT" 2>/dev/null)" \
      || cursor_manifest_status=$?
    cursor_gstack_runtime_root=""
    if [ "$cursor_manifest_status" -eq 0 ]; then
      cursor_gstack_runtime_root="$(printf '%s\n' "$cursor_manifest" | node -e '
        const fs = require("fs");
        const path = require("path");
        const roots = new Set();
        for (const line of fs.readFileSync(0, "utf8").split(/\n/)) {
          const [name, source, mode, provenance] = line.split("\t");
          if (provenance !== "gstack") continue;
          if (!name || !source || mode !== "gstack-copy") process.exit(1);
          const resolved = path.resolve(source);
          const root = path.dirname(path.dirname(path.dirname(resolved)));
          if (path.dirname(resolved) !== path.join(root, ".cursor", "skills")
            || !path.basename(resolved)) process.exit(1);
          roots.add(root);
        }
        if (roots.size > 1) process.exit(1);
        if (roots.size === 1) process.stdout.write([...roots][0]);
      ' 2>/dev/null || true)"
    fi
    cursor_guard_manifest="$cursor_manifest"
    # Manifest generation has its own explicit diagnostic below. Keep the
    # independent root/destination check useful by falling back to the last
    # installed snapshot instead of feeding an empty plan that makes every
    # installed link look stale.
    if [ "$cursor_manifest_status" -ne 0 ] \
      && [ -f "$CURSOR_MANAGED_MANIFEST" ] && [ ! -L "$CURSOR_MANAGED_MANIFEST" ]; then
      cursor_guard_manifest="$(cat "$CURSOR_MANAGED_MANIFEST")"
    fi

    if printf '%s\n' "$cursor_guard_manifest" \
    | node "$CURSOR_ROOT_GUARD" verify \
      "$CURSOR_HOME" "$HOME" "$REPO_ROOT" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
      ok "Cursor managed roots and fixed destinations are safe inside CURSOR_HOME"
    else
      fail "Cursor managed roots or fixed destinations are unsafe" "replace symlinked or writable Cursor destinations with current-user-owned real paths before re-running scripts/bootstrap-cursor.sh"
      if printf '%s\n' "$cursor_guard_manifest" \
      | node "$CURSOR_ROOT_GUARD" verify-boundary \
        "$CURSOR_HOME" "$HOME" "$REPO_ROOT" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
        # The boundary itself is safe. Continue read-only provenance checks so
        # a hardlink/FIFO inside a managed copy gets its actionable skill name.
        cursor_skills_root_safe=1
      else
        cursor_skills_root_safe=0
      fi
      cursor_ok=0
    fi

    if [ -f "$CURSOR_HOOKS_JSON" ]; then
      if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CURSOR_HOOKS_JSON" 2>/dev/null; then
        fail "Cursor hooks.json is not parseable ($CURSOR_HOOKS_JSON)" "re-run scripts/bootstrap-cursor.sh"
        cursor_ok=0
      else
        found_hooks="$(node -e '
          const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks || {};
          const required = [
            ["sessionStart", "./hooks/session-start.js"],
            ["preToolUse", "./hooks/rtk-shell.js"],
            ["preToolUse", "./hooks/enforce-cursor.js"],
            ["beforeShellExecution", "./hooks/enforce-cursor.js"],
            ["beforeMCPExecution", "./hooks/enforce-cursor.js"],
          ];
          for (const [event, cmd] of required) {
            const list = h[event] || [];
            const present = list.some((item) => item && item.command === cmd);
            if (!present) process.stdout.write("MISSING\t" + event + "\t" + cmd + "\n");
            else process.stdout.write("FOUND\t" + event + "\t" + cmd + "\n");
          }
        ' "$CURSOR_HOOKS_JSON" 2>/dev/null)"
        while IFS=$'\t' read -r kind event cmd; do
          [ -z "${kind:-}" ] && continue
          if [ "$kind" = "MISSING" ]; then
            fail "Cursor hooks.json missing jarvis hook under $event: $cmd" "re-run scripts/bootstrap-cursor.sh"
            cursor_ok=0
            continue
          fi
          case "$cmd" in
            ./*) target="$CURSOR_HOME/${cmd#./}" ;;
            /*) target="$cmd" ;;
            *) target="$CURSOR_HOME/$cmd" ;;
          esac
          if is_dangling "$target" || [ ! -e "$target" ]; then
            fail "Cursor hook target missing: $cmd → $target" "re-run scripts/bootstrap-cursor.sh from the current cortex root"
            cursor_ok=0
          fi
        done <<< "$found_hooks"
      fi
    else
      fail "Cursor hooks.json missing ($CURSOR_HOOKS_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ -f "$CURSOR_PERMISSIONS_JSON" ] && node -e '
      const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (p.approvalMode !== "unrestricted") process.exit(1);
      if (!Array.isArray(p.terminalAllowlist) || !p.terminalAllowlist.includes("*")) process.exit(1);
      const allowsAllMcp = Array.isArray(p.mcpAllowlist) && p.mcpAllowlist.includes("*:*");
      if (!allowsAllMcp) process.exit(1);
    ' "$CURSOR_PERMISSIONS_JSON" 2>/dev/null; then
      ok "Cursor permissions are unrestricted for terminal and MCP"
    else
      fail "Cursor permissions are not unrestricted ($CURSOR_PERMISSIONS_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ -f "$CURSOR_MCP_JSON" ] && [ ! -L "$CURSOR_MCP_JSON" ]; then
      case "$cursor_graphify_status" in
        valid)
          ok "Cursor mcp.json has the exact managed graphify-brain configuration"
          ;;
        malformed)
          fail "Cursor mcp.json is not parseable ($CURSOR_MCP_JSON)" "repair the JSON syntax and re-run scripts/bootstrap-cursor.sh"
          cursor_ok=0
          ;;
        missing)
          fail "Cursor mcp.json missing graphify-brain under mcpServers ($CURSOR_MCP_JSON)" "re-run scripts/bootstrap-cursor.sh"
          cursor_ok=0
          ;;
        misconfigured)
          fail "Cursor mcp.json graphify-brain differs from the managed configuration ($CURSOR_MCP_JSON)" "re-run scripts/bootstrap-cursor.sh; the command and args must match cursor/mcp.json exactly"
          cursor_ok=0
          ;;
        *)
          fail "Cursor graphify-brain configuration could not be verified ($cursor_graphify_status)" "repair cursor/mcp.json or the cortex MCP template, then re-run doctor"
          cursor_ok=0
          ;;
      esac
    else
      fail "Cursor mcp.json missing or unsafe ($CURSOR_MCP_JSON)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ -L "$CURSOR_RULE" ] || [ -e "$CURSOR_RULE" ]; then
      if is_dangling "$CURSOR_RULE" || [ ! -e "$CURSOR_RULE" ]; then
        fail "Cursor jarvis-cortex rule dangling ($CURSOR_RULE)" "re-run scripts/bootstrap-cursor.sh"
        cursor_ok=0
      else
        ok "Cursor jarvis-cortex rule resolves"
      fi
    else
      fail "Cursor jarvis-cortex rule missing ($CURSOR_RULE)" "re-run scripts/bootstrap-cursor.sh"
      cursor_ok=0
    fi

    if [ "$cursor_skills_root_safe" -eq 1 ]; then
    cursor_manifest_ok=1
    cursor_manifest_count=0
    cursor_gstack_present=0
    cursor_installed_gstack_present=0
    cursor_installed_manifest=""
    if [ "$cursor_manifest_status" -ne 0 ]; then
      fail "Cursor native skill manifest generation failed (exit $cursor_manifest_status)" "repair invalid skill sources and re-run scripts/bootstrap-cursor.sh"
      cursor_manifest_ok=0
      cursor_ok=0
    elif [ -z "$cursor_manifest" ]; then
      fail "Cursor native skill manifest is empty or invalid" "repair the cortex checkout and re-run scripts/bootstrap-cursor.sh"
      cursor_manifest_ok=0
      cursor_ok=0
    else
      if [ ! -f "$CURSOR_MANAGED_MANIFEST" ] || [ -L "$CURSOR_MANAGED_MANIFEST" ]; then
        fail "Cursor installed skill manifest missing or not a regular file ($CURSOR_MANAGED_MANIFEST)" "re-run scripts/bootstrap-cursor.sh"
        cursor_manifest_ok=0
        cursor_ok=0
        cursor_installed_manifest=""
      else
        cursor_installed_manifest="$(cat "$CURSOR_MANAGED_MANIFEST")"
        cursor_installed_gstack_present="$(node -e '
          const rows = process.argv[1].split(/\n/).filter(Boolean);
          process.stdout.write(rows.some((line) => line.split("\t")[3] === "gstack") ? "1" : "0");
        ' "$cursor_installed_manifest" 2>/dev/null || printf '0')"
        cursor_manifest_findings="$(node -e '
          const fs = require("fs");
          const path = require("path");
          const [installedRaw, desiredRaw] = process.argv.slice(1);
          const pairs = new Set(["link:cortex", "link:hm", "link:caveman", "cursor-copy:cortex", "gstack-copy:gstack"]);
          function parse(raw, label) {
            const rows = new Map();
            for (const line of raw.split(/\n/).filter(Boolean)) {
              const fields = line.split("\t");
              if (fields.length !== 4) {
                process.stdout.write(`INVALID\t${label}\tmalformed row\n`);
                continue;
              }
              const [name, source, mode, provenance] = fields;
              if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === ".."
                || !path.isAbsolute(source) || !pairs.has(`${mode}:${provenance}`)) {
                process.stdout.write(`INVALID\t${label}\t${name || "<empty>"}\n`);
                continue;
              }
              if (rows.has(name)) {
                process.stdout.write(`INVALID\t${label}\tduplicate ${name}\n`);
                continue;
              }
              rows.set(name, { name, source, mode, provenance, line });
            }
            return rows;
          }
          const installed = parse(installedRaw, "installed");
          const desired = parse(desiredRaw, "desired");
          for (const [name, wanted] of desired) {
            const actual = installed.get(name);
            if (!actual) process.stdout.write(`MISSING\t${name}\tdesired row is not installed\n`);
            else if (actual.line !== wanted.line) process.stdout.write(`CHANGED\t${name}\tinstalled row differs from desired\n`);
          }
          for (const [name, actual] of installed) {
            if (!desired.has(name)) process.stdout.write(`STALE\t${name}\tinstalled row is no longer desired\n`);
            try {
              const sourceStat = fs.statSync(actual.source);
              const skillStat = fs.statSync(path.join(actual.source, "SKILL.md"));
              if (!sourceStat.isDirectory() || !skillStat.isFile()) throw new Error("invalid source type");
            } catch {
              process.stdout.write(`SOURCE_MISSING\t${name}\t${actual.source}\n`);
            }
          }
        ' "$cursor_installed_manifest" "$cursor_manifest" 2>/dev/null || printf 'INVALID\tcomparison\tfailed')"
        while IFS=$'\t' read -r finding_kind finding_name finding_detail; do
          [ -n "${finding_kind:-}" ] || continue
          case "$finding_kind" in
            SOURCE_MISSING)
              fail "Cursor managed skill source missing: $finding_name → $finding_detail" "restore the source or re-run scripts/bootstrap-cursor.sh to reconcile stale managed entries"
              ;;
            MISSING|STALE|CHANGED|INVALID)
              fail "Cursor installed skill manifest diverges from desired state: $finding_kind $finding_name" "re-run scripts/bootstrap-cursor.sh; preserved user collisions must be resolved explicitly"
              ;;
          esac
          cursor_manifest_ok=0
          cursor_ok=0
        done <<< "$cursor_manifest_findings"
      fi
      while IFS=$'\t' read -r skill source mode provenance; do
        [ -n "$skill" ] || continue
        cursor_manifest_count=$((cursor_manifest_count + 1))
        [ "$provenance" = "gstack" ] && cursor_gstack_present=1
        sp="$CURSOR_HOME/skills/$skill"
        if [ "$mode" = "cursor-copy" ]; then
          if [ -L "$sp" ] || [ ! -f "$sp/SKILL.md" ] \
            || ! node "$CURSOR_COPY_TOOL" verify "$source" "$sp" >/dev/null 2>&1; then
            fail "Cursor native skill has unexpected provenance: $skill" "re-run scripts/bootstrap-cursor.sh; preserve user-owned collisions under a different name"
            cursor_manifest_ok=0
            cursor_ok=0
          fi
          continue
        fi
        if [ "$mode" = "gstack-copy" ]; then
          if [ -L "$sp" ] || [ ! -f "$sp/SKILL.md" ] \
            || ! node "$CURSOR_GSTACK_TOOL" skill-verify \
              "$source" "$sp" "" "$GSTACK_REPO_ROOT" >/dev/null 2>&1; then
            fail "Cursor native gstack skill has unexpected provenance: $skill" "re-run scripts/bootstrap-cursor.sh"
            cursor_manifest_ok=0
            cursor_ok=0
          fi
          continue
        fi
        if [ ! -L "$sp" ] || is_dangling "$sp" || [ ! -f "$sp/SKILL.md" ]; then
          fail "Cursor native skill missing, dangling, or not managed: $skill" "re-run scripts/bootstrap-cursor.sh"
          cursor_manifest_ok=0
          cursor_ok=0
          continue
        fi
        if ! is_exact_link_target "$sp" "$source"; then
          fail "Cursor native skill has unexpected provenance: $skill" "re-run scripts/bootstrap-cursor.sh; preserve user-owned collisions under a different name"
          cursor_manifest_ok=0
          cursor_ok=0
        fi
      done <<< "$cursor_manifest"
    fi
    [ "$cursor_manifest_ok" -eq 1 ] \
      && ok "Cursor native skill manifest resolves with exact provenance ($cursor_manifest_count skills)"
    cursor_bun_ok=1
    if [ "$cursor_gstack_present" -eq 1 ] || [ "$cursor_installed_gstack_present" -eq 1 ]; then
      cursor_bun_bin="$(command -v bun 2>/dev/null || true)"
      if [ -n "$cursor_bun_bin" ] && [ -f "$cursor_bun_bin" ] && [ -x "$cursor_bun_bin" ]; then
        ok "Bun executable is available for Cursor gstack skills"
      else
        fail "Bun executable missing for Cursor gstack skills" "install Bun and ensure bun is executable on PATH, then re-run scripts/bootstrap-cursor.sh"
        cursor_bun_ok=0
        cursor_ok=0
      fi
    fi
    if [ "$cursor_gstack_present" -eq 1 ] && [ "$cursor_bun_ok" -eq 1 ]; then
      if [ -n "$cursor_gstack_runtime_root" ] \
      && node "$CURSOR_GSTACK_TOOL" runtime-verify "$cursor_gstack_runtime_root" \
        "$CURSOR_HOME/jarvis-runtime/gstack" "$CURSOR_HOME/skills" >/dev/null 2>&1; then
        ok "Cursor gstack runtime wrapper resolves outside the skills tree"
      else
        fail "Cursor gstack runtime wrapper is misplaced or has unexpected provenance" "re-run scripts/bootstrap-cursor.sh"
        cursor_ok=0
      fi
    elif [ "$cursor_installed_gstack_present" -eq 1 ] \
      || [ -e "$CURSOR_HOME/jarvis-runtime/gstack" ] \
      || [ -L "$CURSOR_HOME/jarvis-runtime/gstack" ]; then
      fail "Cursor stale gstack manifest/runtime exists without desired gstack skills" "restore the gstack source or re-run scripts/bootstrap-cursor.sh to reconcile exact prior ownership"
      cursor_ok=0
    fi

    if [ "$cursor_manifest_status" -eq 0 ] && [ -n "$cursor_manifest" ] \
      && [ -f "$CURSOR_MANAGED_MANIFEST" ] && [ ! -L "$CURSOR_MANAGED_MANIFEST" ]; then
      cursor_audit="$(node "$CURSOR_AUDIT_TOOL" "$CURSOR_HOME/skills" \
        --manifests "$CURSOR_MANAGED_MANIFEST" "$cursor_manifest" "$REPO_ROOT" 2>/dev/null || true)"
    else
      cursor_audit="$(node "$CURSOR_AUDIT_TOOL" "$CURSOR_HOME/skills" 2>/dev/null || true)"
    fi
    if [ -z "$cursor_audit" ]; then
      fail "Cursor native skill tree could not be audited" "re-run scripts/bootstrap-cursor.sh and verify Node.js can read $CURSOR_HOME/skills"
      cursor_ok=0
    else
      cursor_backup_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).backups.length))' "$cursor_audit" 2>/dev/null || true)"
      duplicate_cursor_names="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).duplicates.map((item) => item.name).join(","))' "$cursor_audit" 2>/dev/null || true)"
      cursor_cycle_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).cycles.length))' "$cursor_audit" 2>/dev/null || true)"
      cursor_dangling_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).dangling.length))' "$cursor_audit" 2>/dev/null || true)"
      cursor_escape_count="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).unapprovedEscapes || []).length))' "$cursor_audit" 2>/dev/null || true)"
      cursor_allowed_escape_count="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).allowedEscapes || []).length))' "$cursor_audit" 2>/dev/null || true)"
      cursor_escape_reconciliation_error_count="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).reconciliationErrors || []).filter((error) => !String(error.code || "").startsWith("managed-marker-")).length))' "$cursor_audit" 2>/dev/null || true)"
      cursor_managed_marker_error_names="$(node -e 'process.stdout.write([...new Set((JSON.parse(process.argv[1]).reconciliationErrors || []).filter((error) => String(error.code || "").startsWith("managed-marker-")).map((error) => error.name || "<unknown>"))].sort().join(","))' "$cursor_audit" 2>/dev/null || true)"
      cursor_metadata_error_count="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).errors || []).length))' "$cursor_audit" 2>/dev/null || true)"
      if [ "${cursor_backup_count:-0}" -gt 0 ]; then
        fail "backup skill trees under Cursor skills ($cursor_backup_count SKILL.md)" "move .backups, backup, backups, and *.backup.* trees outside $CURSOR_HOME/skills"
        cursor_ok=0
      else
        ok "no backup skill trees under Cursor skills"
      fi
      if [ -n "$duplicate_cursor_names" ]; then
        fail "duplicate Cursor native skill names: $duplicate_cursor_names" "keep one canonical directory per skill name"
        cursor_ok=0
      else
        ok "Cursor native skill names are unique recursively"
      fi
      if [ "${cursor_cycle_count:-0}" -gt 0 ]; then
        fail "symlink cycles under Cursor skills ($cursor_cycle_count)" "remove cyclic links from $CURSOR_HOME/skills"
        cursor_ok=0
      fi
      if [ "${cursor_dangling_count:-0}" -gt 0 ]; then
        fail "dangling symlinks under Cursor skills ($cursor_dangling_count)" "repair or remove dangling links from $CURSOR_HOME/skills"
        cursor_ok=0
      fi
      if [ "${cursor_escape_count:-0}" -gt 0 ]; then
        fail "unmanaged symlink escapes under Cursor skills ($cursor_escape_count)" "remove external directory/SKILL.md links, or restore an exact installed+desired managed link with canonical source provenance"
        cursor_ok=0
      elif [ "${cursor_escape_reconciliation_error_count:-0}" -gt 0 ]; then
        fail "Cursor skill manifest reconciliation could not trust installed targets ($cursor_escape_reconciliation_error_count errors)" "repair the installed manifest/target identity and re-run scripts/bootstrap-cursor.sh"
        cursor_ok=0
      elif [ "${cursor_allowed_escape_count:-0}" -gt 0 ]; then
        ok "external Cursor skill links are exact manifest-authorized sources ($cursor_allowed_escape_count paths)"
      else
        ok "no unmanaged symlink escapes under Cursor skills"
      fi
      if [ -n "$cursor_managed_marker_error_names" ]; then
        fail "orphaned or mismatched Jarvis markers under Cursor skills: $cursor_managed_marker_error_names" "restore the exact source and re-run scripts/bootstrap-cursor.sh; do not delete preserved user data blindly"
        cursor_ok=0
      fi
      if [ "${cursor_metadata_error_count:-0}" -gt 0 ]; then
        fail "invalid or unsupported Cursor skill metadata ($cursor_metadata_error_count SKILL.md)" "use a plain name key with a supported plain, single-quoted, or double-quoted scalar"
        cursor_ok=0
      fi
    fi
    fi

  fi

  # This check is shell/sqlite based and must still run if Node is unavailable.
  third_party_state="$(cursor_third_party_state)"
  if [ "$third_party_state" = "off" ]; then
    ok "Cursor third-party imports are explicitly disabled"
  else
    fail "Cursor third-party imports are not proven disabled ($third_party_state)" "in Cursor Settings → Rules, Skills and Subagents, disable 'Include Third-Party Plugins, Skills, and Other Configs', then reload Cursor and re-run doctor"
    cursor_ok=0
  fi

  [ "$cursor_ok" -eq 1 ] && ok "Cursor harness wiring resolves"
else
  group "CURSOR harness"
  warn "Cursor harness not found ($CURSOR_HOME) — Cursor not set up on this machine"
fi

# ---------------------------------------------------------------------------
group "SUMMARY"
printf 'doctor: %d ok, %d warn, %d fail\n' "$OK_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  printf '\nRemediation:\n'
  for hint in "${FAIL_HINTS[@]}"; do
    printf '  - %s\n' "$hint"
  done
  exit 1
fi
exit 0
