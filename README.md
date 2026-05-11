# codex-heartbeat

A small local manager for Codex app-server sessions and named heartbeat workers.

The goal is to keep heartbeat state outside any one project repo, so the same tool can be used across multiple agent sessions. It uses the Codex app-server protocol and only sends a heartbeat when the target thread is loaded and idle.

## Current Shape

- One managed Codex app-server by default.
- Many named heartbeat sessions.
- Per-session state under `~/.codex-heartbeat/sessions/<name>/`.
- Per-server state under `~/.codex-heartbeat/servers/<name>/`.
- No npm runtime dependencies; requires Node 22+ and the `codex` CLI.

## Commands

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
node bin/codex-heartbeat.mjs session list
node bin/codex-heartbeat.mjs session status --name dropship-main
```

Stop a session:

```bash
node bin/codex-heartbeat.mjs session stop --name dropship-main
```

Clean stale sessions and stop the managed app-server when no heartbeat workers are running:

```bash
node bin/codex-heartbeat.mjs reap
```

## Session Rules

The heartbeat worker treats `loaded + idle` as the only safe send condition:

- If the thread is `idle`, it sends with `turn/start`.
- If the thread is `active`, it queues one heartbeat and sends after the thread becomes idle.
- If the thread is not loaded, it waits until a target has been selected.
- If a previously selected target becomes unloaded or emits `thread/closed`, the worker exits and marks the session stale or closed.

This deliberately avoids `codex exec resume` for live-session heartbeats because that can create overlapping turns instead of behaving like a queued user message in the same app-server session.

## Development

```bash
npm test
npm run smoke
```

Install locally if wanted:

```bash
npm link
codex-heartbeat status
```
