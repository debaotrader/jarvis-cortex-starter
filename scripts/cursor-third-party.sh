#!/usr/bin/env bash

# Prints one of: off, on, unset, missing-db, no-sqlite, unreadable.
cursor_third_party_state() {
  local data_dir state_db value
  if [ -n "${CURSOR_USER_DATA_DIR:-}" ]; then
    data_dir="$CURSOR_USER_DATA_DIR/User"
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
    data_dir="$HOME/Library/Application Support/Cursor/User"
  elif [ -n "${APPDATA:-}" ]; then
    data_dir="$APPDATA/Cursor/User"
  else
    data_dir="${XDG_CONFIG_HOME:-$HOME/.config}/Cursor/User"
  fi
  state_db="${CURSOR_STATE_DB:-$data_dir/globalStorage/state.vscdb}"

  command -v sqlite3 >/dev/null 2>&1 || { printf '%s\n' no-sqlite; return 0; }
  [ -f "$state_db" ] || { printf '%s\n' missing-db; return 0; }
  value="$(sqlite3 -readonly "$state_db" \
    "SELECT value FROM ItemTable WHERE key='cursor/thirdPartyExtensibilityEnabled' LIMIT 1;" \
    2>/dev/null || true)"
  case "$value" in
    false) printf '%s\n' off ;;
    true) printf '%s\n' on ;;
    '') printf '%s\n' unset ;;
    *) printf '%s\n' unreadable ;;
  esac
}
