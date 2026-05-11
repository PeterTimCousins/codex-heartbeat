import path from 'node:path';
import { fileTimestamp, slugifyName } from './fs-util.mjs';
import { DEFAULT_URL, serverDir } from './paths.mjs';
import { isMatchingPidRunning, spawnDetached, terminateMatchingPid, waitForReadyz } from './processes.mjs';
import { readServerState, writeServerState } from './state.mjs';

function now() {
  return new Date().toISOString();
}

function serverCommandFragment(url) {
  return `app-server --listen ${url}`;
}

function isManagedServerRunning(state) {
  if (!state?.pid) {
    return false;
  }
  if (!state.managed) {
    return isMatchingPidRunning(state.pid);
  }
  return isMatchingPidRunning(state.pid, state.commandFragment ?? serverCommandFragment(state.url));
}

export async function startServer({ name = 'default', url = DEFAULT_URL, foreground = false } = {}) {
  const safeName = slugifyName(name);
  const existing = readServerState(safeName);
  if (existing?.pid && isManagedServerRunning(existing)) {
    return { started: false, state: existing, message: `App-server ${safeName} already running with pid ${existing.pid}` };
  }

  const logFile = path.join(serverDir(safeName), 'logs', `server.${fileTimestamp()}.log`);
  const commandFragment = serverCommandFragment(url);

  if (foreground) {
    writeServerState(safeName, {
      name: safeName,
      url,
      pid: process.pid,
      managed: true,
      foreground: true,
      commandFragment,
      logFile,
      startedAt: now(),
      updatedAt: now(),
    });
    return { foregroundCommand: ['codex', 'app-server', '--listen', url] };
  }

  const pid = spawnDetached('codex', ['app-server', '--listen', url], { logFile });
  const state = {
    name: safeName,
    url,
    pid,
    managed: true,
    foreground: false,
    commandFragment,
    logFile,
    startedAt: now(),
    updatedAt: now(),
  };
  writeServerState(safeName, state);

  const ready = await waitForReadyz(url, logFile);
  return { started: true, state, ready };
}

export function stopServer({ name = 'default' } = {}) {
  const safeName = slugifyName(name);
  const state = readServerState(safeName);
  if (!state?.pid) {
    return { stopped: false, message: `No app-server state found for ${safeName}` };
  }
  if (!state.managed) {
    return { stopped: false, state, message: `Refusing to stop app-server ${safeName}; recorded state is not manager-owned` };
  }
  const commandFragment = state.commandFragment ?? serverCommandFragment(state.url);
  if (!isMatchingPidRunning(state.pid, commandFragment)) {
    writeServerState(safeName, {
      ...state,
      running: false,
      status: 'stale',
      statusDetail: `Recorded pid ${state.pid} is not the managed app-server command`,
      updatedAt: now(),
    });
    return { stopped: false, state, message: `Recorded pid ${state.pid} is not the managed app-server command for ${safeName}` };
  }
  const stopped = terminateMatchingPid(state.pid, commandFragment);
  writeServerState(safeName, {
    ...state,
    running: false,
    stoppedAt: now(),
    updatedAt: now(),
  });
  return { stopped, state };
}

export function serverStatus(name = 'default', fallbackUrl = DEFAULT_URL) {
  const safeName = slugifyName(name);
  const state = readServerState(safeName);
  if (!state) {
    return { name: safeName, running: false, url: fallbackUrl };
  }
  return {
    ...state,
    running: isManagedServerRunning(state),
  };
}
