# Repository Guidelines

This repo is a standalone Codex app-server and heartbeat manager.

## Project Structure

- `bin/codex-heartbeat.mjs`: executable CLI entrypoint.
- `src/cli.mjs`: command routing and output.
- `src/server-manager.mjs`: managed `codex app-server` process lifecycle.
- `src/session-manager.mjs`: named heartbeat session lifecycle.
- `src/session-runner.mjs`: background worker that sends heartbeat messages.
- `src/app-server-client.mjs`: small JSON-RPC WebSocket client for the Codex app-server protocol.
- `test/`: Node test runner tests.

## Commands

- `npm test`: run unit tests.
- `npm run smoke`: check the CLI help and status command.
- `node bin/codex-heartbeat.mjs status`: inspect managed server and sessions.

## Design Rules

Keep the app repo-agnostic. Do not store state inside target project repos; use `~/.codex-heartbeat` unless explicitly configured by `CODEX_HEARTBEAT_HOME`.

Heartbeat sessions are named and isolated. Do not add global single-session files for heartbeat PID, thread ID, stop state, or logs.

Only send heartbeats to loaded, idle app-server threads. Use `thread/loaded/list`, `thread/read`, `thread/status/changed`, and `thread/closed` to decide whether a target is safe. Never use `codex exec resume` for live-session heartbeats.

Avoid killing app-server processes the manager did not start. Process cleanup should rely on recorded manager-owned state.

Use dependency-free Node ESM unless a dependency removes real complexity.
