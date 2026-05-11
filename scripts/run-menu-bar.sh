#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$("$REPO_ROOT/scripts/build-menu-bar.sh")"

CODEX_HEARTBEAT_CLI="${CODEX_HEARTBEAT_CLI:-$REPO_ROOT/bin/codex-heartbeat.mjs}" open -n "$APP"
