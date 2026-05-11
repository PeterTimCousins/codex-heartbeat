import path from 'node:path';
import { fileTimestamp, slugifyName } from './fs-util.mjs';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_MESSAGE, DEFAULT_URL, sessionDir, sessionLogDir } from './paths.mjs';
import { isPidRunning, spawnDetached, terminatePid } from './processes.mjs';
import { serverStatus, startServer, stopServer } from './server-manager.mjs';
import {
  clearStopMarker,
  hasStopMarker,
  listSessionNames,
  readSessionState,
  updateSessionState,
  writeSessionState,
  writeStopMarker,
} from './state.mjs';

export async function startSession(options) {
  const name = slugifyName(options.name);
  const intervalSeconds = Number(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    throw new Error('--interval must be a positive number of seconds');
  }
  const existing = readSessionState(name);
  if (existing?.pid && isPidRunning(existing.pid)) {
    return { started: false, state: existing, message: `Session ${name} already running with pid ${existing.pid}` };
  }

  let url = options.url;
  if (!url) {
    const server = serverStatus(options.serverName ?? 'default');
    if (!server.running) {
      const started = await startServer({ name: options.serverName ?? 'default', url: DEFAULT_URL });
      url = started.state?.url ?? DEFAULT_URL;
    } else {
      url = server.url;
    }
  }

  clearStopMarker(name);

  const logFile = path.join(sessionLogDir(name), `heartbeat.${fileTimestamp()}.log`);
  const state = {
    name,
    url,
    serverName: options.serverName ?? 'default',
    cwd: path.resolve(options.cwd ?? process.cwd()),
    threadId: options.threadId ?? null,
    intervalSeconds,
    message: options.message ?? DEFAULT_MESSAGE,
    once: Boolean(options.once),
    immediate: Boolean(options.immediate || options.once),
    status: 'starting',
    pid: null,
    logFile,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeSessionState(name, state);

  const pid = spawnDetached(process.execPath, [new URL('./session-runner.mjs', import.meta.url).pathname, '--name', name], {
    cwd: sessionDir(name),
    logFile,
  });
  const nextState = { ...state, pid, status: 'running', updatedAt: new Date().toISOString() };
  writeSessionState(name, nextState);
  return { started: true, state: nextState };
}

export function stopSession(name, reason = 'manual') {
  const safeName = slugifyName(name);
  const state = readSessionState(safeName);
  writeStopMarker(safeName, reason);
  if (!state?.pid) {
    updateSessionState(safeName, { status: 'stopped' });
    return { stopped: false, message: `No pid recorded for session ${safeName}` };
  }
  const stopped = terminatePid(state.pid);
  updateSessionState(safeName, { status: 'stopped', stoppedAt: new Date().toISOString() });
  return { stopped, state };
}

export function sessionStatus(name) {
  const state = readSessionState(name);
  if (!state) {
    return null;
  }
  return {
    ...state,
    running: isPidRunning(state.pid),
    stopped: hasStopMarker(name),
  };
}

export function listSessions() {
  return listSessionNames().map((name) => sessionStatus(name)).filter(Boolean);
}

export function reapSessions() {
  const sessions = listSessions();
  const reaped = [];
  for (const session of sessions) {
    if (session.pid && !session.running && !['stopped', 'closed', 'stale'].includes(session.status)) {
      updateSessionState(session.name, { status: 'stale' });
      reaped.push(session.name);
    }
  }
  return reaped;
}

export function reapManagedState() {
  const reapedSessions = reapSessions();
  const runningSessions = listSessions().filter((session) => session.running);
  const server = serverStatus('default');
  let stoppedServer = false;
  if (server.running && server.managed && runningSessions.length === 0) {
    stoppedServer = stopServer({ name: 'default' }).stopped;
  }
  return { reapedSessions, stoppedServer };
}
