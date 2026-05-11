#!/usr/bin/env bash
set -euo pipefail

LABEL="com.codex-heartbeat.menu"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_APP="${CODEX_HEARTBEAT_APP_PATH:-$HOME/Applications/Codex Heartbeat.app}"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -rf "$INSTALL_APP"

echo "Removed $PLIST"
echo "Removed $INSTALL_APP"
