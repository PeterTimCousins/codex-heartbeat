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

If the auto-named heartbeat session for that directory is already running, the wrapper refuses to launch Codex. This avoids opening a second same-cwd Codex session that could cause the existing unpinned heartbeat to follow the wrong thread. Stop or restart the existing heartbeat first, or pass a distinct `--heartbeat-name` and pin it with `--heartbeat-thread` when you deliberately need a separate session.

The same flow is available from the menu bar app as **Start Codex with Heartbeat...**. The app asks for a project folder, opens the configured terminal app in that folder, and runs the wrapped Codex command using the saved preferences.

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

Launch Codex directly into a named existing thread and pin the heartbeat to that same thread:

```bash
node bin/codex-heartbeat.mjs codex \
  --heartbeat-thread "e2e extended testing" \
  -- --yolo resume "e2e extended testing"
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

Trigger a running session to send one heartbeat as soon as the target thread is idle:

```bash
node bin/codex-heartbeat.mjs session trigger --name dropship-main
```

Stop the heartbeat for the current Codex thread from inside the running agent:

```bash
codex-heartbeat stop-current --reason "Blocked: need user input"
```

`stop-current` first matches the running heartbeat session by `CODEX_THREAD_ID`, then falls back to `CODEX_HEARTBEAT_SESSION_NAME` for sessions launched through `codex-heartbeat codex`.

Inspect or update defaults used by the menu app:

```bash
node bin/codex-heartbeat.mjs preferences --json
node bin/codex-heartbeat.mjs preferences set \
  --server-name default \
  --server-url ws://127.0.0.1:18654 \
  --heartbeat-interval 1800 \
  --heartbeat-message "Heartbeat check: Are we done? If complete, report completion. If blocked, ask exactly what input is needed. If not blocked and no user input is needed, continue the next safe, coherent step." \
  --heartbeat-thread "e2e extended testing" \
  --codex-args "--yolo" \
  --launch-app "Terminal" \
  --keep-heartbeat false
```

The menu app's **Open Codex in** setting supports Terminal, iTerm, cmux/Ghostty, and an **Other...** option for compatible terminal apps that accept command arguments through `open --args`.

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
- Sessions started without `--thread` follow the active loaded thread for the configured cwd. They retarget on app-server `thread/started` and `thread/status/changed` events, and they use app-server `thread/list` plus `thread/resume` as a conservative fallback when `/resume` updates recency without emitting a loaded-thread event.
- For unpinned sessions, the worker also watches Codex's local `~/.codex/logs_2.sqlite` resume lifecycle log as a best-effort `/resume` detector. This is used only to notice an already-loaded resumed thread, and the candidate is still verified through the app-server as a loaded thread for the same cwd before retargeting. If the log database or `sqlite3` command is unavailable, normal heartbeat behavior continues without this detector.
- Sessions started with `--thread` are pinned to that exact thread. The wrapper also accepts `--heartbeat-thread THREAD_ID_OR_NAME` and `--heartbeat-thread-name NAME`, which is the reliable path when launching directly into an existing thread with `codex resume`.
- Only one running unpinned session can follow a given cwd on a given app-server URL. Start a second session with `--thread` if you deliberately need exact thread pinning.
- If no matching thread is loaded, an unpinned session waits for one to appear.
- If a pinned target becomes unloaded or emits `thread/closed`, the worker exits and marks the session stale or closed.
- If a heartbeat asks an agent to continue but the agent is blocked waiting for user input, the agent can run `codex-heartbeat stop-current --reason "Blocked: <short reason>"` to stop its heartbeat without needing to know the heartbeat session name.

This deliberately avoids `codex exec resume` for live-session heartbeats because that can create overlapping turns instead of behaving like a queued user message in the same app-server session.

### `/resume` Detection

`/new` is detected through the app-server `thread/started` event. `/resume` is different: current Codex builds do not expose a stable app-server event for "the foreground TUI changed from thread X to thread Y".

For unpinned sessions, `codex-heartbeat` therefore uses a best-effort detector:

- On worker start, it records the current high-watermark from `~/.codex/logs_2.sqlite`.
- During the normal heartbeat poll loop, it looks only for newer Codex app-server lifecycle rows containing `composing running thread resume response`.
- It extracts the resumed thread ID, then verifies through the app-server that the thread is loaded and belongs to the same cwd before retargeting.
- If `~/.codex/logs_2.sqlite` or `sqlite3` is unavailable, the worker logs that detection is disabled and continues with normal heartbeat behavior.

This relies on Codex private local log details, so it may need adjustment if Codex changes its logging. To verify it worked, open the session log shown by `codex-heartbeat status` and look for lines like:

```text
Codex /resume log detection enabled from log id ...
detected Codex /resume log for thread <thread-id>
retargeted from thread <old-id> to codex-resume-log thread <new-id> status=idle
```

The stable alternative is to launch directly into a known thread and pin the heartbeat:

```bash
codex-heartbeat codex \
  --heartbeat-thread "e2e extended testing" \
  -- --yolo resume "e2e extended testing"
```

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

The menu bar app uses the CLI as its control plane. It reads `status --json`, can start or stop the default app-server, starts Codex with heartbeat in a chosen project folder, lists heartbeat sessions, stops individual sessions, opens session logs, and changes a session interval by restarting that heartbeat worker. **Open Control Panel...** is the main UI for sessions and common settings. Advanced defaults such as server name, server URL, preferred thread, and Codex args are kept behind an advanced disclosure to reduce accidental breakage. Preferences are stored in `~/.codex-heartbeat/preferences.json`, and the menu includes Enable/Disable Launch at Login. If you run the compiled binary outside the `.app` bundle, set `CODEX_HEARTBEAT_CLI` to the CLI path.

Install locally if wanted:

```bash
npm link
codex-heartbeat status
```
