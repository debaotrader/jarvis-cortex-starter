#!/usr/bin/env bash
# scripts/install.sh — unified entrypoint to install the Jarvis cortex on a
# fresh machine across harnesses (Claude Code app+CLI, Codex, opencode, Cursor).
#
# Runs the matching per-harness bootstrap, then doctor.sh as a verification.
# Idempotent: re-runnable. Honors the same env overrides the bootstraps do
# (HOME, CLAUDE_HOME, CODEX_HOME, CURSOR_HOME, INSTALL_GSTACK, INSTALL_KARPATHY)
# — they propagate to the child scripts for free.
#
# Usage:
#   install.sh                 # all harnesses (default)
#   install.sh all             # all harnesses
#   install.sh claude          # Claude Code only
#   install.sh codex           # Codex only
#   install.sh opencode        # opencode only
#   install.sh cursor          # Cursor IDE only
#   install.sh -h | --help     # this help
#
# Codex requires the `codex` CLI in PATH. With `all`, a missing codex CLI is
# skipped (claude+opencode+cursor still install). Asked for `codex` explicitly
# with no CLI, it fails with bootstrap-codex.sh's message.
#
# bootstrap-opencode.sh refuses to touch a config it cannot manage safely (no
# jarvis-managed marker pair, a symlink, not a regular file) and exits 3
# without writing anything. With `all` that is skipped — a stale opencode
# config must not stop Cursor, Codex or the health check — and the reason is
# printed. Asked for `opencode` explicitly, it fails. Any other non-zero exit
# is an unexpected failure and aborts even under `all`.

set +o keyword   # ver nota abaixo — precisa vir antes do modo estrito
# Primeiro comando executável de propósito: `set -Eeuo pipefail` ACRESCENTA
# opções e nunca limpa as que o bash importou de SHELLOPTS antes da linha 1.
# `keyword` faz `local d="$1"` virar atribuição de ambiente e derruba o
# script com variável não vinculada — medido. Uma linha resolve.
# `onecmd` NÃO é resolvível daqui: o shell sai depois de UM comando, seja
# qual for, inclusive este — medido em todas as formas. Ver AMBIENTE
# HERDADO: está fora de escopo por decisão, junto com `noexec`.

set -euo pipefail

# `$( )` strips EVERY trailing newline, so a directory whose name legally ends
# in one silently becomes a DIFFERENT directory — the same truncation class the
# bootstraps close with their own sentinel helpers. `pwd` emits exactly one
# terminating newline, so appending a sentinel and removing it plus that single
# newline round-trips the name intact. SCRIPT_DIR is captured the same way and
# not only REPO_ROOT: REPO_ROOT is derived FROM it, so fixing only the second
# would leave the first free to corrupt it.
capture_dir() {
  local out
  # `builtin cd`/`builtin pwd`: with a shell function named cd, SCRIPT_DIR
  # resolved one level high and this script dispatched
  # <repo>/bootstrap-claude.sh instead of <repo>/scripts/bootstrap-claude.sh —
  # a different file entirely (measured). `command cd` would bypass such a
  # function too on Bash 3.2.57; `builtin` is chosen for naming the builtin
  # directly, not for being stronger, and neither is a trust boundary.
  #
  # `local CDPATH=`: cd PRINTS the directory it selected when it resolves via
  # CDPATH, and that line lands in this capture, giving two lines where one is
  # required. With CDPATH=. exported, `install.sh --help` exited 1.
  local CDPATH=
  out="$(builtin cd -- "$1" && builtin pwd && printf X)" || return 1
  out="${out%X}"
  CAPTURED="${out%$'\n'}"
}
# Directory part by parameter expansion, NOT `$(dirname …)` — that command
# substitution would strip the very trailing newline this helper exists to
# preserve, truncating the name before capture_dir ever sees it.
CAPTURED=""
SELF_DIR="${BASH_SOURCE[0]}"
case "$SELF_DIR" in
  */*) SELF_DIR="${SELF_DIR%/*}"; [ -n "$SELF_DIR" ] || SELF_DIR=/ ;;
  *)   SELF_DIR=. ;;
esac
capture_dir "$SELF_DIR" || { echo "install.sh: cannot resolve the script directory" >&2; exit 1; }
SCRIPT_DIR="$CAPTURED"
capture_dir "$SCRIPT_DIR/.." || { echo "install.sh: cannot resolve the repo root" >&2; exit 1; }
REPO_ROOT="$CAPTURED"

MODE="${1:-all}"
case "$MODE" in
  all|claude|codex|opencode|cursor|graphify) ;;
  -h|--help)
    # Leading comment block by sentinel, not by line range — a hardcoded range
    # needed bumping on every header edit. Line 1 is skipped only if it really
    # is a shebang; blank lines and indented comments belong to the header and
    # do not terminate it.
    awk 'NR == 1 && /^#!/ { next }
         /^[[:space:]]*#/ { print; next }
         /^[[:space:]]*$/ { print; next }
         { exit }' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown argument: $MODE (expected: claude | codex | opencode | cursor | graphify | all)" >&2
    exit 2
    ;;
esac

run_claude() {
  echo "==> Claude Code bootstrap"
  command "$SCRIPT_DIR/bootstrap-claude.sh"
}

run_opencode() {
  # bootstrap-opencode.sh types its outcomes (see its header): exit 3 is a
  # deliberate refusal — it wrote nothing and the user must fix the config by
  # hand. That is the same "non-fatal, keep going" class run_cursor and
  # run_codex skip under `all`; a stale opencode config is not a reason to
  # leave Cursor, Codex and the health check uninstalled. Any other non-zero
  # exit is an unexpected failure and aborts.
  #
  # Unlike the other two the condition cannot be probed up front — only the
  # bootstrap can tell whether the config carries its marker pair — so it runs
  # first and the header is already on screen when the skip is decided. The
  # bootstrap has printed the full reason and the repair steps by then.
  local rc=0
  echo "==> opencode bootstrap"
  command "$SCRIPT_DIR/bootstrap-opencode.sh" || rc=$?
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$MODE" = all ] && [ "$rc" -eq 3 ]; then
    echo "==> opencode bootstrap: SKIPPED (config cannot be managed as-is; see the reason above)"
    echo "    Follow those steps, then run 'scripts/install.sh opencode'."
    return 0
  fi
  return "$rc"
}

run_cursor() {
  # `all` mode: missing node is non-fatal — skip so other harnesses still run.
  # Explicit `cursor`: let bootstrap-cursor.sh fail with its own message.
  # `command type -P`, not `command -v`: the latter reports a shell FUNCTION
  # named node as present, so the skip decision would not reflect PATH.
  if [ "$MODE" = all ] && [ -z "$(command type -P node 2>/dev/null || true)" ]; then
    echo "==> Cursor IDE bootstrap: SKIPPED (node not in PATH)"
    echo "    Run 'scripts/install.sh cursor' after installing Node.js."
    return 0
  fi
  echo "==> Cursor IDE bootstrap"
  command "$SCRIPT_DIR/bootstrap-cursor.sh"
}

run_codex() {
  # `all` mode: a missing codex CLI is non-fatal — skip so other harnesses
  # still succeed. Explicit `codex`: let bootstrap-codex.sh emit its own
  # "codex CLI not found" message and exit 1.
  # See run_cursor: PATH binaries only, a function named codex is not a CLI.
  if [ "$MODE" = all ] && [ -z "$(command type -P codex 2>/dev/null || true)" ]; then
    echo "==> Codex bootstrap: SKIPPED (codex CLI not in PATH)"
    echo "    Run 'scripts/install.sh codex' after installing the Codex CLI."
    return 0
  fi
  echo "==> Codex bootstrap"
  command "$SCRIPT_DIR/bootstrap-codex.sh"
}

run_graphify() {
  # O Brain é um repositório PRIVADO, um por pessoa: este script não pode
  # cloná-lo nem inventá-lo. Por isso a dependência é sondada aqui em vez de
  # deixar o setup falhar — setup-graphify-brain.sh sai 1 tanto para "Brain
  # ausente" quanto para falha inesperada, e um exit ambíguo não serve de base
  # para decidir entre pular e abortar.
  #
  # A resolução espelha resolve_brain_home() do setup: JARVIS_BRAIN_HOME vence,
  # senão o default. A chave graphifyBrainPath do config.json NÃO é lida aqui —
  # exigiria node, e uma sonda que depende de node falharia por motivo errado
  # numa máquina sem ele. Quem usa essa chave cai no skip e roda o setup direto,
  # que é o caminho documentado.
  local brain="${JARVIS_BRAIN_HOME:-$HOME/.jarvis/brain}"
  if [ ! -d "$brain/.git" ]; then
    if [ "$MODE" = all ]; then
      echo "==> Jarvis Brain: SKIPPED (repositório não encontrado em $brain)"
      echo "    Clone o Brain privado ali, ou defina JARVIS_BRAIN_HOME, e rode"
      echo "    'scripts/setup-graphify-brain.sh --all'."
      return 0
    fi
    echo "Jarvis Brain não encontrado: $brain" >&2
    echo "Clone o repositório privado ali ou defina JARVIS_BRAIN_HOME." >&2
    return 1
  fi
  echo "==> Jarvis Brain (graphify MCP)"
  command "$SCRIPT_DIR/setup-graphify-brain.sh" --all
}

case "$MODE" in
  claude)   run_claude ;;
  opencode) run_opencode ;;
  cursor)   run_cursor ;;
  codex)    run_codex ;;
  graphify) run_graphify ;;
  all)
    run_claude
    run_opencode
    run_cursor
    run_codex
    run_graphify
    ;;
esac

# Verification — doctor.sh exits 1 on FAIL. Capture so install.sh doesn't abort
# under `set -e`; surface a non-zero exit clearly but don't fail the install
# just because doctor warns.
echo ""
echo "==> Health check (scripts/doctor.sh)"
doctor_rc=0
command "$SCRIPT_DIR/doctor.sh" || doctor_rc=$?
if [ "$doctor_rc" -ne 0 ]; then
  echo "" >&2
  echo "doctor reported issues (exit $doctor_rc) — review the FAIL lines above." >&2
fi

echo ""
printf 'Install complete (cortex root: %q).\n' "$REPO_ROOT"
echo ""
echo "Next steps:"
echo "  - Claude Code statusLine (caveman): the caveman plugin installs on Claude"
echo "    Code's FIRST launch, after this script runs. Re-run 'scripts/install.sh"
echo "    claude' once after that first launch to provision the statusLine."
echo "  - Cursor: Reload Window (Cmd+Shift+P) after bootstrap so MCP + hooks load."
echo "  - Jarvis Brain: se foi PULADO acima, clone o repositório privado em"
echo "    '~/.jarvis/brain' (ou defina JARVIS_BRAIN_HOME) e rode"
echo "    'scripts/install.sh graphify'."
echo "  - Codex MCPs (optional): run 'scripts/install-codex-mcps.sh' (needs API keys)."

# Propagate doctor's exit so install.sh is a trustworthy gate (0 = healthy install).
exit "$doctor_rc"
