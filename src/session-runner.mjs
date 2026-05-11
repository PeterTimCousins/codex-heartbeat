#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { AppServerClient } from './app-server-client.mjs';
import { appendLine } from './fs-util.mjs';
import { hasStopMarker, readSessionState, updateSessionState } from './state.mjs';

function parseArgs(argv) {
  const args = { name: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--name') {
      args.name = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.name) {
    throw new Error('--name is required');
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollIntervalMs(intervalSeconds) {
  const intervalMs = Math.max(1, Number(intervalSeconds)) * 1000;
  return Math.min(intervalMs, 5000);
}

async function loadedThreadIds(client) {
  const ids = [];
  let cursor = null;
  do {
    const result = await client.request('thread/loaded/list', { cursor, limit: 100 });
    ids.push(...(result?.data ?? []));
    cursor = result?.nextCursor ?? null;
  } while (cursor);
  return ids;
}

async function readThread(client, threadId) {
  const result = await client.request('thread/read', { threadId, includeTurns: false });
  return result?.thread ?? null;
}

export function compareThreadRecency(a, b) {
  const updatedDiff = Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  const createdDiff = Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

export async function findLoadedThreadForCwd(client, cwd, logFile) {
  const ids = await loadedThreadIds(client);
  const threads = [];
  for (const id of ids) {
    try {
      const thread = await readThread(client, id);
      if (thread?.cwd === cwd && thread.status?.type !== 'notLoaded') {
        threads.push(thread);
      }
    } catch (error) {
      appendLine(logFile, `failed to read loaded thread ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  threads.sort(compareThreadRecency);
  return threads[0] ?? null;
}

export function shouldFollowCwdThread(state) {
  if (Object.hasOwn(state, 'threadPinned')) {
    return !state.threadPinned;
  }
  return !state.threadId;
}

async function main() {
  const { name } = parseArgs(process.argv.slice(2));
  const state = readSessionState(name);
  if (!state) {
    throw new Error(`No session state found for ${name}`);
  }

  const logFile = state.logFile;
  appendLine(logFile, `starting session name=${name} url=${state.url} cwd=${state.cwd} interval=${state.intervalSeconds}s`);

  const client = new AppServerClient(state.url, logFile);
  let targetThreadId = state.threadId;
  let targetStatus = null;
  let hasEverLoaded = false;
  let queuedHeartbeat = false;
  let sentOnce = false;
  const followCwdThread = shouldFollowCwdThread(state);

  function mark(updates) {
    updateSessionState(name, updates);
  }

  async function refreshTarget() {
    if (followCwdThread) {
      const thread = await findLoadedThreadForCwd(client, state.cwd, logFile);
      if (!thread) {
        targetStatus = null;
        mark({
          status: 'waiting_for_thread',
          statusDetail: targetThreadId
            ? `No loaded thread found for cwd ${state.cwd}; previous target ${targetThreadId} is not selected`
            : `No loaded thread found for cwd ${state.cwd}`,
        });
        return null;
      }

      const nextStatus = thread.status?.type ?? null;
      if (thread.id !== targetThreadId) {
        const previousThreadId = targetThreadId;
        targetThreadId = thread.id;
        appendLine(
          logFile,
          previousThreadId
            ? `retargeted from thread ${previousThreadId} to latest loaded thread ${targetThreadId} status=${nextStatus}`
            : `selected thread ${targetThreadId} status=${nextStatus}`,
        );
      }

      targetStatus = nextStatus;
      hasEverLoaded = true;
      mark({
        threadId: targetThreadId,
        status: targetStatus,
        statusDetail: null,
      });
      return thread;
    }

    if (!targetThreadId) {
      const thread = await findLoadedThreadForCwd(client, state.cwd, logFile);
      if (!thread) {
        mark({ status: 'waiting_for_thread', statusDetail: `No loaded thread found for cwd ${state.cwd}` });
        return null;
      }
      targetThreadId = thread.id;
      targetStatus = thread.status?.type ?? null;
      hasEverLoaded = true;
      mark({ threadId: targetThreadId, status: targetStatus });
      appendLine(logFile, `selected thread ${targetThreadId} status=${targetStatus}`);
      return thread;
    }

    const loaded = await loadedThreadIds(client);
    if (!loaded.includes(targetThreadId)) {
      if (hasEverLoaded) {
        mark({ status: 'stale', statusDetail: 'Target thread is no longer loaded' });
        appendLine(logFile, `target thread ${targetThreadId} no longer loaded; exiting`);
        process.exit(0);
      }
      mark({ status: 'waiting_for_thread', statusDetail: `Target thread ${targetThreadId} is not loaded yet` });
      return null;
    }

    const thread = await readThread(client, targetThreadId);
    targetStatus = thread?.status?.type ?? null;
    hasEverLoaded = true;
    mark({ status: targetStatus, threadId: targetThreadId });
    return thread;
  }

  async function sendHeartbeat(reason) {
    const thread = await refreshTarget();
    if (!thread) {
      appendLine(logFile, `skip heartbeat (${reason}): no loaded target thread`);
      return false;
    }

    if (targetStatus === 'active') {
      queuedHeartbeat = true;
      mark({ status: 'active', queuedHeartbeat: true });
      appendLine(logFile, `queue heartbeat (${reason}): target thread is active`);
      return false;
    }

    if (targetStatus !== 'idle') {
      appendLine(logFile, `skip heartbeat (${reason}): target status is ${targetStatus}`);
      return false;
    }

    appendLine(logFile, `send heartbeat (${reason}) thread=${targetThreadId}`);
    await client.request('turn/start', {
      threadId: targetThreadId,
      input: [{ type: 'text', text: state.message }],
    });
    sentOnce = true;
    mark({ status: 'active', queuedHeartbeat: false, lastHeartbeatAt: new Date().toISOString() });
    return true;
  }

  client.on('thread/status/changed', (params) => {
    if (params?.threadId !== targetThreadId) {
      return;
    }
    targetStatus = params?.status?.type ?? null;
    mark({ status: targetStatus });
    appendLine(logFile, `thread ${targetThreadId} status=${targetStatus}`);
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      sendHeartbeat('queued-after-idle').catch((error) => {
        appendLine(logFile, `queued heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  client.on('thread/closed', (params) => {
    if (params?.threadId !== targetThreadId) {
      return;
    }
    if (followCwdThread) {
      appendLine(logFile, `thread ${targetThreadId} closed; waiting for a new loaded cwd target`);
      targetThreadId = null;
      targetStatus = null;
      mark({ status: 'waiting_for_thread', threadId: null, statusDetail: 'Target thread closed; waiting for a new loaded cwd target' });
      refreshTarget().catch((error) => {
        appendLine(logFile, `refresh after thread close failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    mark({ status: 'closed', statusDetail: 'App-server reported thread/closed' });
    appendLine(logFile, `thread ${targetThreadId} closed; exiting`);
    client.close();
    process.exit(0);
  });

  client.on('turn/completed', (params) => {
    if (params?.threadId !== targetThreadId) {
      return;
    }
    targetStatus = 'idle';
    mark({ status: 'idle' });
    if (queuedHeartbeat) {
      queuedHeartbeat = false;
      sendHeartbeat('queued-after-turn-completed').catch((error) => {
        appendLine(logFile, `queued heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  client.on('websocket/closed', (params) => {
    const detail = `App-server WebSocket closed code=${params?.code ?? 'unknown'}`;
    mark({ status: 'failed', statusDetail: detail });
    appendLine(logFile, `${detail}; exiting`);
    process.exit(1);
  });

  client.on('websocket/error', (params) => {
    appendLine(logFile, `websocket error: ${params?.message ?? 'unknown'}`);
  });

  await client.connect();
  await client.initialize('codex-heartbeat-session');
  await refreshTarget();

  if (state.immediate) {
    await sendHeartbeat(state.once ? 'once' : 'immediate');
  }

  const heartbeatIntervalMs = Math.max(1, Number(state.intervalSeconds)) * 1000;
  const pollMs = pollIntervalMs(state.intervalSeconds);
  let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;

  while (!state.once || !sentOnce || targetStatus === 'active') {
    if (hasStopMarker(name)) {
      mark({ status: 'stopped', statusDetail: 'Stop marker found' });
      appendLine(logFile, 'stop marker found; exiting');
      client.close();
      process.exit(0);
    }

    await sleep(pollMs);

    if (hasStopMarker(name)) {
      mark({ status: 'stopped', statusDetail: 'Stop marker found' });
      appendLine(logFile, 'stop marker found; exiting');
      client.close();
      process.exit(0);
    }

    if (state.once && !sentOnce) {
      await sendHeartbeat('once-retry');
      continue;
    }

    await refreshTarget();
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      await sendHeartbeat('queued-after-poll-idle');
    }

    if (!state.once && Date.now() >= nextHeartbeatAt) {
      await sendHeartbeat('interval');
      nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
    }
  }

  mark({ status: 'completed', statusDetail: 'Once mode completed' });
  client.close();
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    const args = parseArgs(process.argv.slice(2));
    const state = readSessionState(args.name);
    if (state?.logFile) {
      appendLine(state.logFile, error instanceof Error ? error.stack ?? error.message : String(error));
    }
    updateSessionState(args.name, {
      status: 'failed',
      statusDetail: error instanceof Error ? error.message : String(error),
    });
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
