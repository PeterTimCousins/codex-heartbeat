# codex-heartbeat

A small local manager for Codex app-server sessions and named heartbeat workers.

The goal is to keep heartbeat state outside any one project repo, so the same tool can be used across multiple agent sessions. It uses the Codex app-server protocol and only sends a heartbeat when the target thread is loaded and idle.

## Quick Start

From a fresh clone:

```bash
npm install
npm run setup
```

Then start Codex with a managed app-server and heartbeat from any project:

```bash
codex-heartbeat codex --yolo
```

Useful setup and diagnostic commands:

```bash
codex-heartbeat --help
codex-heartbeat init
codex-heartbeat doctor
npm run menu
```

`npm run setup` links the CLI with `npm link`, creates default preferences under `~/.codex-heartbeat/preferences.json`, builds the menu bar app, and prints next steps. Use `codex-heartbeat init --install-menu` if you also want to install the menu app as a login item. The menu app installs to `~/Applications/Codex Heartbeat.app` by default, so launch-at-login does not depend on the repo `build/` directory.

## Current Shape

- One managed Codex app-server by default.
- Many named heartbeat sessions.
- Per-session state under `~/.codex-heartbeat/sessions/<name>/`.
- Per-server state under `~/.codex-heartbeat/servers/<name>/`.
- Sessions started with `--url` and no `--server` are treated as external to managed server cleanup.
- No npm runtime dependencies; requires Node 22+ and the `codex` CLI.

## Commands

Start Codex with a managed app-server and heartbeat in one command, from this checkout without linking:

```bash
node bin/codex-heartbeat.mjs codex --yolo
```

This starts or reuses the managed app-server, starts a heartbeat session for the current directory, then runs `codex --remote <managed-url> --yolo`. The heartbeat stops when the wrapped Codex process exits.

The same flow is available from the menu bar app as **Start Codex with Heartbeat...**. The app asks for a project folder, opens Terminal in that folder, and runs the wrapped Codex command using the saved preferences.

Useful wrapper options:

```bash
node bin/codex-heartbeat.mjs codex \
  --server main \
  --heartbeat-interval 1800 \
  --heartbeat-name my-repo \
  --keep-heartbeat \
  --yolo
```

Start the app-server:

```bash
node bin/codex-heartbeat.mjs server start
```

Connect a Codex TUI to the managed app-server:

```bash
node bin/codex-heartbeat.mjs remote -- --yolo
```

Start a named heartbeat for the current repo:

```bash
node bin/codex-heartbeat.mjs session start \
  --name dropship-main \
  --cwd "/Volumes/4TB External SSD/Dropshipping Web Application/dropship-app" \
  --interval 1800
```

Target a specific WebSocket URL without binding the session to a managed server:

```bash
node bin/codex-heartbeat.mjs session start \
  --name external-main \
  --url ws://127.0.0.1:18665 \
  --cwd "$PWD"
```

If that URL belongs to a managed server and you want `reap` to keep the server alive while the session runs, also pass `--server <name>`.

Start a short one-shot smoke heartbeat:

```bash
node bin/codex-heartbeat.mjs session start \
  --name smoke \
  --cwd "$PWD" \
  --interval 60 \
  --once \
  --message "Heartbeat arrived. Reply exactly HEARTBEAT_RECEIVED."
```

Inspect state:

```bash
node bin/codex-heartbeat.mjs status
node bin/codex-heartbeat.mjs status --json
node bin/codex-heartbeat.mjs session list
node bin/codex-heartbeat.mjs session status --name dropship-main
```

Inspect or update defaults used by the menu app:

```bash
node bin/codex-heartbeat.mjs preferences --json
node bin/codex-heartbeat.mjs preferences set \
  --server-name default \
  --server-url ws://127.0.0.1:18654 \
  --heartbeat-interval 1800 \
  --codex-args "--yolo" \
  --keep-heartbeat false
```

Stop a session:

```bash
node bin/codex-heartbeat.mjs session stop --name dropship-main
```

Remove a stopped session from `~/.codex-heartbeat`:

```bash
node bin/codex-heartbeat.mjs session remove --name dropship-main
```

Clean stale sessions and stop the managed app-server when no heartbeat workers are running:

```bash
node bin/codex-heartbeat.mjs reap
```

## Session Rules

The heartbeat worker treats `loaded + idle` as the only safe send condition:

- If the thread is `idle`, it sends with `turn/start`.
- If the thread is `active`, it queues one heartbeat and sends after the thread becomes idle.
- Sessions started without `--thread` follow the newest loaded thread for the configured cwd. This lets a wrapped Codex session continue heartbeating after `/new` creates a new thread.
- Sessions started with `--thread` are pinned to that exact thread.
- Only one running unpinned session can follow a given cwd on a given app-server URL. Start a second session with `--thread` if you deliberately need exact thread pinning.
- If no matching thread is loaded, an unpinned session waits for one to appear.
- If a pinned target becomes unloaded or emits `thread/closed`, the worker exits and marks the session stale or closed.

This deliberately avoids `codex exec resume` for live-session heartbeats because that can create overlapping turns instead of behaving like a queued user message in the same app-server session.

## Development

```bash
npm test
npm run smoke
npm run build:menu
```

Run the macOS menu bar app during development:

```bash
npm run menu
```

The build writes `build/CodexHeartbeatMenu.app`. The app is a menu bar app (`LSUIElement`), uses `macos/CodexHeartbeatMenu/AppIcon.png` for the app and menu bar icon, and bundles the CLI sources under `Contents/Resources/codex-heartbeat`.

Install or remove the menu app as a login item:

```bash
npm run install:menu
npm run uninstall:menu
```

`npm run install:menu` builds the app, copies it to `~/Applications/Codex Heartbeat.app`, and installs a LaunchAgent pointing at that stable app path. `npm run uninstall:menu` removes the LaunchAgent and installed app but leaves `~/.codex-heartbeat` state intact. Override the install path with `CODEX_HEARTBEAT_APP_PATH`.

The menu bar app uses the CLI as its control plane. It reads `status --json`, can start or stop the default app-server, starts Codex with heartbeat in a chosen project folder, lists heartbeat sessions, stops individual sessions, opens session logs, and changes a session interval by restarting that heartbeat worker. It also includes **Dashboard...** for a compact server/session management window, stores preferences in `~/.codex-heartbeat/preferences.json`, exposes those defaults through **Settings...**, and includes Enable/Disable Launch at Login. If you run the compiled binary outside the `.app` bundle, set `CODEX_HEARTBEAT_CLI` to the CLI path.

Install locally if wanted:

```bash
npm link
codex-heartbeat status
```
