#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-}"
LABEL="com.codex-heartbeat.menu"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOAD_NOW=1

if [ "${1:-}" = "--no-load" ]; then
  LOAD_NOW=0
  APP="${2:-}"
fi

if [ -z "$APP" ]; then
  APP="$("$REPO_ROOT/scripts/build-menu-bar.sh")"
fi

EXECUTABLE="$APP/Contents/MacOS/CodexHeartbeatMenu"
if [ ! -x "$EXECUTABLE" ]; then
  echo "Menu app executable not found: $EXECUTABLE" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

mkdir -p "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$EXECUTABLE")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
if [ "$LOAD_NOW" -eq 1 ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

echo "$PLIST"
