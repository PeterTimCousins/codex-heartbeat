import path from 'node:path';
import { fileTimestamp, slugifyName } from './fs-util.mjs';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_MESSAGE, DEFAULT_URL, sessionDir, sessionLogDir } from './paths.mjs';
import { isMatchingPidRunning, spawnDetached, terminateMatchingPid } from './processes.mjs';
import { serverStatus, startServer, stopServer } from './server-manager.mjs';
import {
  clearStopMarker,
  deleteSessionState,
  listServerNames,
  hasStopMarker,
  listSessionNames,
  readSessionState,
  updateSessionState,
  writeSessionState,
  writeStopMarker,
} from './state.mjs';

function sessionCommandFragment(name) {
  return `session-runner.mjs --name ${name}`;
}

function isSessionRunnerRunning(state) {
  if (!state?.pid) {
    return false;
  }
  return isMatchingPidRunning(state.pid, state.commandFragment ?? sessionCommandFragment(state.name));
}

function sessionServerName(session) {
  if (Object.hasOwn(session, 'serverName')) {
    return session.serverName;
  }
  return 'default';
}

function sessionFollowsCwd(session) {
  if (Object.hasOwn(session, 'threadPinned')) {
    return !session.threadPinned;
  }
  return !session.threadId;
}

export function findUnpinnedCwdConflict({ name, cwd, url }) {
  const resolvedCwd = path.resolve(cwd);
  return listSessions().find(
    (session) =>
      session.name !== name &&
      session.running &&
      sessionFollowsCwd(session) &&
      session.cwd === resolvedCwd &&
      session.url === url,
  ) ?? null;
}

export async function startSession(options) {
  const name = slugifyName(options.name);
  const requestedServerName = options.serverName ? slugifyName(options.serverName) : null;
  const intervalSeconds = Number(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const threadPinned = Boolean(options.threadId);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    throw new Error('--interval must be a positive number of seconds');
  }
  const existing = readSessionState(name);
  if (existing?.pid && isSessionRunnerRunning(existing)) {
    return { started: false, state: existing, message: `Session ${name} already running with pid ${existing.pid}` };
  }

  let url = options.url;
  let serverName = requestedServerName;
  if (!url) {
    serverName = requestedServerName ?? 'default';
    const server = serverStatus(serverName);
    if (!server.running) {
      if (serverName !== 'default') {
        throw new Error(
          `Server ${serverName} is not running. Start it with "codex-heartbeat server start --name ${serverName} --url URL" or pass --url.`,
        );
      }
      const started = await startServer({ name: serverName, url: DEFAULT_URL });
      url = started.state?.url ?? DEFAULT_URL;
    } else {
      url = server.url;
    }
  } else if (!serverName) {
    serverName = null;
  }

  if (!threadPinned) {
    const conflict = findUnpinnedCwdConflict({ name, cwd, url });
    if (conflict) {
      throw new Error(
        `Session ${conflict.name} is already following cwd ${cwd} on ${url}. Stop it first or pass --thread to pin this session to a specific thread.`,
      );
    }
  }

  clearStopMarker(name);

  const logFile = path.join(sessionLogDir(name), `heartbeat.${fileTimestamp()}.log`);
  const state = {
    name,
    url,
    serverName,
    cwd,
    threadId: options.threadId ?? null,
    threadPinned,
    intervalSeconds,
    message: options.message ?? DEFAULT_MESSAGE,
    once: Boolean(options.once),
    immediate: Boolean(options.immediate || options.once),
    status: 'starting',
    pid: null,
    commandFragment: sessionCommandFragment(name),
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
  const stopped = terminateMatchingPid(state.pid, state.commandFragment ?? sessionCommandFragment(safeName));
  updateSessionState(safeName, { status: 'stopped', stoppedAt: new Date().toISOString() });
  return { stopped, state };
}

export function removeSession(name, { force = false } = {}) {
  const safeName = slugifyName(name);
  const state = readSessionState(safeName);
  if (!state) {
    return { removed: false, message: `Session ${safeName} not found` };
  }
  if (isSessionRunnerRunning(state)) {
    if (!force) {
      throw new Error(`Session ${safeName} is still running. Stop it first or pass --force.`);
    }
    stopSession(safeName, 'removed');
  }
  deleteSessionState(safeName);
  return { removed: true, name: safeName };
}

export function sessionStatus(name) {
  const safeName = slugifyName(name);
  const state = readSessionState(safeName);
  if (!state) {
    return null;
  }
  return {
    ...state,
    running: isSessionRunnerRunning(state),
    stopped: hasStopMarker(safeName),
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
  const stoppedServers = [];
  for (const serverName of listServerNames()) {
    const server = serverStatus(serverName);
    const hasRunningSession = runningSessions.some((session) => sessionServerName(session) === serverName);
    if (server.running && server.managed && !hasRunningSession) {
      const result = stopServer({ name: serverName });
      if (result.stopped) {
        stoppedServers.push(serverName);
      }
    }
  }
  return { reapedSessions, stoppedServers, stoppedServer: stoppedServers.includes('default') };
}
