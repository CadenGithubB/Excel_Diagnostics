#!/bin/bash
# Double-click launcher for macOS. Runs the installer, keeps a copy of everything it printed in
# install-report.txt beside this file, and leaves the window open so the result can be read.
set -uo pipefail
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$INSTALLER_DIR/plugin/deploy.sh" "$@" 2>&1 | tee "$INSTALLER_DIR/install-report.txt"
# The installer's own exit status, not tee's: a failed install must not look like a success to whoever started this.
INSTALL_RESULT=${PIPESTATUS[0]}
if [[ -t 0 ]]; then
  echo
  read -r -p 'Press Return to close this window. ' _reply
fi
exit "$INSTALL_RESULT"
