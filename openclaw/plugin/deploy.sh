#!/bin/bash
# Entry point of the Excel Diagnostics installer: finds Node and hands every argument to install.mjs.
# Run as the account that owns the OpenClaw Gateway, without sudo. Try it with --check first.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A double-clicked launcher starts with a short PATH, so the usual places Node is installed are added in front.
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME:+$HOME/.npm-global/bin:}${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
NODE_BIN="${EXCEL_DIAGNOSTICS_NODE:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo 'Node.js is required. Set EXCEL_DIAGNOSTICS_NODE to the Node executable used by OpenClaw.' >&2
  exit 1
fi
exec "$NODE_BIN" "$SCRIPT_DIR/install.mjs" "$@"
