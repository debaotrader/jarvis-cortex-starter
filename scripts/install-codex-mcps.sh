#!/usr/bin/env bash
set -euo pipefail

N8N_API_URL="${N8N_API_URL:?defina N8N_API_URL com sua instancia}"
TESTSPRITE_KEY="${TESTSPRITE_API_KEY:-${API_KEY:-}}"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found in PATH. Install/open Codex first, then rerun this script." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found in PATH. Install Node.js first." >&2
  exit 1
fi

if [ -n "${N8N_API_KEY:-}" ]; then
  codex mcp remove n8n >/dev/null 2>&1 || true
  codex mcp add n8n \
    --env "N8N_API_KEY=$N8N_API_KEY" \
    --env "N8N_API_URL=$N8N_API_URL" \
    -- npx -y n8n-mcp-server@0.1.0
else
  echo "Skipping n8n: set N8N_API_KEY to install it."
fi

if [ -n "$TESTSPRITE_KEY" ]; then
  codex mcp remove TestSprite >/dev/null 2>&1 || true
  codex mcp add TestSprite \
    --env "API_KEY=$TESTSPRITE_KEY" \
    -- npx -y @testsprite/testsprite-mcp@0.0.37
else
  echo "Skipping TestSprite: set TESTSPRITE_API_KEY to install it."
fi

codex mcp remove MetaAds >/dev/null 2>&1 || true
codex mcp add MetaAds --url https://mcp.facebook.com/ads

if [ "${LOGIN_METAADS:-0}" = "1" ]; then
  codex mcp login MetaAds
else
  echo "MetaAds added. Run 'codex mcp login MetaAds' on the Mac when you want OAuth login."
fi

codex mcp list
