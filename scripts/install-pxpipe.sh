#!/usr/bin/env bash
set -euo pipefail

PXPIPE_PACKAGE="${PXPIPE_PACKAGE:-pxpipe-proxy}"
PXPIPE_VERSION="${PXPIPE_VERSION:-0.8.0}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH. Install Node.js/npm before installing pxpipe." >&2
  exit 1
fi

npm install -g "$PXPIPE_PACKAGE@$PXPIPE_VERSION"

if ! command -v pxpipe >/dev/null 2>&1; then
  echo "pxpipe installed, but the pxpipe binary is not on PATH." >&2
  echo "Check your npm global bin directory and shell PATH." >&2
  exit 1
fi

pxpipe --help >/dev/null

pkg_version="$(npm ls -g "$PXPIPE_PACKAGE" --depth=0 2>/dev/null | sed -n "s/.*$PXPIPE_PACKAGE@//p" | head -n 1 || true)"
if [ -n "$pkg_version" ]; then
  echo "pxpipe installed: $PXPIPE_PACKAGE@$pkg_version ($(command -v pxpipe))"
else
  echo "pxpipe installed: $(command -v pxpipe)"
fi
echo "Start the proxy with: scripts/pxpipe.sh start"
echo "Run Claude through it with: scripts/pxpipe.sh claude"
