import path from 'node:path';
import { fileTimestamp } from './fs-util.mjs';
import { DEFAULT_URL, serverDir } from './paths.mjs';
import { isPidRunning, spawnDetached, terminatePid, waitForReadyz } from './processes.mjs';
import { readServerState, writeServerState } from './state.mjs';

export async function startServer({ name = 'default', url = DEFAULT_URL, foreground = false } = {}) {
  const existing = readServerState(name);
  if (existing?.pid && isPidRunning(existing.pid)) {
    return { started: false, state: existing, message: `App-server ${name} already running with pid ${existing.pid}` };
  }

  const logFile = path.join(serverDir(name), 'logs', `server.${fileTimestamp()}.log`);

  if (foreground) {
    writeServerState(name, {
      name,
      url,
      pid: process.pid,
      managed: true,
      foreground: true,
      logFile,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { foregroundCommand: ['codex', 'app-server', '--listen', url] };
  }

  const pid = spawnDetached('codex', ['app-server', '--listen', url], { logFile });
  const state = {
    name,
    url,
    pid,
    managed: true,
    foreground: false,
    logFile,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeServerState(name, state);

  const ready = await waitForReadyz(url, logFile);
  return { started: true, state, ready };
}

export function stopServer({ name = 'default' } = {}) {
  const state = readServerState(name);
  if (!state?.pid) {
    return { stopped: false, message: `No app-server state found for ${name}` };
  }
  const stopped = terminatePid(state.pid);
  writeServerState(name, {
    ...state,
    running: false,
    stoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { stopped, state };
}

export function serverStatus(name = 'default') {
  const state = readServerState(name);
  if (!state) {
    return { name, running: false, url: DEFAULT_URL };
  }
  return {
    ...state,
    running: isPidRunning(state.pid),
  };
}
