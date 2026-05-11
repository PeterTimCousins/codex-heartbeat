#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

npm link
node "$REPO_ROOT/bin/codex-heartbeat.mjs" init --build-menu

cat <<'NEXT'

Setup complete.

Start Codex with heartbeat from any project:
  codex-heartbeat codex --yolo

Open the menu bar app:
  npm run menu

Install the menu bar app for launch at login:
  npm run install:menu

Run diagnostics:
  codex-heartbeat doctor
NEXT
