#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_APP="${CODEX_HEARTBEAT_APP_PATH:-$HOME/Applications/Codex Heartbeat.app}"
LOAD_ARG=()

if [ "${1:-}" = "--no-load" ]; then
  LOAD_ARG=(--no-load)
fi

BUILT_APP="$("$REPO_ROOT/scripts/build-menu-bar.sh")"
mkdir -p "$(dirname "$INSTALL_APP")"
rm -rf "$INSTALL_APP"
/usr/bin/ditto "$BUILT_APP" "$INSTALL_APP"

if [ "${#LOAD_ARG[@]}" -gt 0 ]; then
  PLIST="$("$REPO_ROOT/scripts/install-launch-agent.sh" "${LOAD_ARG[@]}" "$INSTALL_APP")"
else
  PLIST="$("$REPO_ROOT/scripts/install-launch-agent.sh" "$INSTALL_APP")"
fi

echo "Installed app: $INSTALL_APP"
echo "Installed launch agent: $PLIST"
