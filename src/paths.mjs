import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 18654;
export const DEFAULT_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;
export const DEFAULT_INTERVAL_SECONDS = 1800;
export const DEFAULT_MESSAGE =
  'Heartbeat check: Are we done? If complete, report completion. If blocked, ask exactly what input is needed. If not blocked and no user input is needed, continue the next safe, coherent step.';

export function stateRoot() {
  return process.env.CODEX_HEARTBEAT_HOME || path.join(os.homedir(), '.codex-heartbeat');
}

export function serversRoot() {
  return path.join(stateRoot(), 'servers');
}

export function sessionsRoot() {
  return path.join(stateRoot(), 'sessions');
}

export function serverDir(name = 'default') {
  return path.join(serversRoot(), name);
}

export function sessionDir(name) {
  return path.join(sessionsRoot(), name);
}

export function sessionLogDir(name) {
  return path.join(sessionDir(name), 'logs');
}
