#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { AppServerClient } from './app-server-client.mjs';
import { extractResumeThreadId, readCodexLogHighWatermark, readCodexResumeLogRows } from './codex-log-watch.mjs';
import { appendLine } from './fs-util.mjs';
import { clearTriggerMarker, hasStopMarker, hasTriggerMarker, listSessionNames, readSessionState, updateSessionState } from './state.mjs';

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

async function listThreads(client) {
  const threads = [];
  let cursor = null;
  do {
    const result = await client.request('thread/list', { cursor, limit: 100 });
    threads.push(...(result?.data ?? []));
    cursor = result?.nextCursor ?? null;
  } while (cursor);
  return threads;
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
      const thread = await readLoadedThreadForCwd(client, id, cwd, logFile);
      if (thread) {
        threads.push(thread);
      }
    } catch (error) {
      appendLine(logFile, `failed to read loaded thread ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  threads.sort(compareThreadRecency);
  return threads[0] ?? null;
}

export async function findLoadedThreadForCwdSince(client, cwd, afterCreatedAt, logFile) {
  const ids = await loadedThreadIds(client);
  const threads = [];
  for (const id of ids) {
    try {
      const thread = await readLoadedThreadForCwd(client, id, cwd, logFile);
      const createdAt = Number(thread?.createdAt ?? thread?.updatedAt ?? 0);
      if (thread && createdAt >= Number(afterCreatedAt ?? 0)) {
        threads.push(thread);
      }
    } catch (error) {
      appendLine(logFile, `failed to read loaded thread ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  threads.sort(compareThreadRecency);
  return threads[0] ?? null;
}

export async function readLoadedThreadForCwd(client, threadId, cwd, logFile) {
  if (!threadId) {
    return null;
  }
  const thread = await readThread(client, threadId);
  if (thread?.cwd === cwd && thread.status?.type !== 'notLoaded') {
    return thread;
  }
  return null;
}

export async function resolveFollowCwdThread(client, cwd, currentThreadId, logFile) {
  const current = await readLoadedThreadForCwd(client, currentThreadId, cwd, logFile);
  if (current) {
    return current;
  }
  return findLoadedThreadForCwd(client, cwd, logFile);
}

export async function preserveEventSelectedThread(client, cwd, targetAtRefreshStart, currentTargetThreadId, candidateThread, logFile) {
  if (currentTargetThreadId && currentTargetThreadId !== targetAtRefreshStart && candidateThread?.id !== currentTargetThreadId) {
    const eventSelectedThread = await readLoadedThreadForCwd(client, currentTargetThreadId, cwd, logFile);
    if (eventSelectedThread) {
      return eventSelectedThread;
    }
  }
  return candidateThread;
}

export async function findRecentThreadListCandidateForCwd(
  client,
  cwd,
  { afterUpdatedAt = 0, currentThreadId = null, handledThreadIds = new Set() } = {},
) {
  const threads = await listThreads(client);
  const candidates = threads.filter((thread) => (
    thread?.id
    && thread.id !== currentThreadId
    && !handledThreadIds.has(thread.id)
    && thread.cwd === cwd
    && thread.status?.type === 'notLoaded'
    && Number(thread.updatedAt ?? 0) > afterUpdatedAt
  ));
  candidates.sort(compareThreadRecency);
  return candidates[0] ?? null;
}

export async function resumeThreadForCwd(client, threadId, cwd) {
  if (!threadId) {
    return null;
  }
  const result = await client.request('thread/resume', {
    threadId,
    cwd,
    excludeTurns: true,
  });
  const thread = result?.thread ?? null;
  if (thread?.cwd === cwd && thread.status?.type !== 'notLoaded') {
    return thread;
  }
  return null;
}

export function shouldFollowCwdThread(state) {
  if (Object.hasOwn(state, 'threadPinned')) {
    return !state.threadPinned;
  }
  return !state.threadId;
}

export function shouldUseRecentThreadListFallback({ followCwdThread, codexResumeLogEnabled }) {
  return Boolean(followCwdThread && !codexResumeLogEnabled);
}

export function isThreadReservedByOtherClaimSession(currentName, currentState, thread) {
  if (!thread?.id) {
    return false;
  }
  const createdAt = Number(thread.createdAt ?? thread.updatedAt ?? 0);
  for (const sessionName of listSessionNames()) {
    if (sessionName === currentName) {
      continue;
    }
    const session = readSessionState(sessionName);
    if (!session?.claimNewThread || session.threadId) {
      continue;
    }
    if (['stopped', 'closed', 'stale', 'failed'].includes(session.status)) {
      continue;
    }
    if (session.url !== currentState.url || session.cwd !== currentState.cwd) {
      continue;
    }
    if (createdAt >= Number(session.claimThreadAfter ?? 0)) {
      return true;
    }
  }
  return false;
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
  let claimNewThread = Boolean(state.claimNewThread && !state.threadId);
  const claimThreadAfter = Number(state.claimThreadAfter ?? 0);
  const followCwdThread = !claimNewThread && shouldFollowCwdThread(state);
  let followResumeLog = Boolean(state.followResumeLog);
  const followResumeLogUntil = Date.parse(state.followResumeLogUntil ?? '');
  let recentThreadListAfterUpdatedAt = Math.floor(Date.now() / 1000);
  const handledRecentThreadListIds = new Set();
  let codexResumeLogLastSeenId = 0;
  let codexResumeLogEnabled = false;

  function mark(updates) {
    updateSessionState(name, updates);
  }

  function isoFromMs(ms) {
    return new Date(ms).toISOString();
  }

  async function refreshTarget() {
    if (claimNewThread && !targetThreadId) {
      const thread = await findLoadedThreadForCwdSince(client, state.cwd, claimThreadAfter, logFile);
      if (!thread) {
        targetStatus = null;
        mark({
          status: 'waiting_for_thread',
          statusDetail: `Waiting for a new loaded thread for cwd ${state.cwd}`,
        });
        return null;
      }
      if (!claimNewThread || targetThreadId) {
        return refreshTarget();
      }
      claimThread(thread, 'claim-new-thread');
      return thread;
    }

    if (followCwdThread) {
      const targetAtRefreshStart = targetThreadId;
      let thread = await resolveFollowCwdThread(client, state.cwd, targetAtRefreshStart, logFile);
      thread = await preserveEventSelectedThread(client, state.cwd, targetAtRefreshStart, targetThreadId, thread, logFile);
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

  const heartbeatIntervalMs = Math.max(1, Number(state.intervalSeconds)) * 1000;
  const pollMs = pollIntervalMs(state.intervalSeconds);
  let nextHeartbeatAt = Date.now() + heartbeatIntervalMs;

  function scheduleNextHeartbeat(fromMs = Date.now()) {
    nextHeartbeatAt = fromMs + heartbeatIntervalMs;
    mark({ nextHeartbeatAt: isoFromMs(nextHeartbeatAt) });
  }

  async function sendHeartbeat(reason) {
    const thread = await refreshTarget();
    if (!thread) {
      appendLine(logFile, `skip heartbeat (${reason}): no loaded target thread`);
      return false;
    }

    if (targetStatus === 'active') {
      queuedHeartbeat = true;
      mark({
        status: 'active',
        statusDetail: 'Heartbeat queued; target thread is active',
        queuedHeartbeat: true,
        nextHeartbeatAt: null,
      });
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
    const sentAt = Date.now();
    scheduleNextHeartbeat(sentAt);
    mark({
      status: 'active',
      statusDetail: null,
      queuedHeartbeat: false,
      lastHeartbeatAt: isoFromMs(sentAt),
      nextHeartbeatAt: isoFromMs(nextHeartbeatAt),
    });
    return true;
  }

  function setTargetThread(thread, reason, statusOverride = null) {
    const nextStatus = statusOverride ?? thread.status?.type ?? null;
    if (thread.id !== targetThreadId) {
      const previousThreadId = targetThreadId;
      targetThreadId = thread.id;
      appendLine(
        logFile,
        previousThreadId
          ? `retargeted from thread ${previousThreadId} to ${reason} thread ${targetThreadId} status=${nextStatus}`
          : `selected ${reason} thread ${targetThreadId} status=${nextStatus}`,
      );
    }

    targetStatus = nextStatus;
    hasEverLoaded = true;
    mark({
      threadId: targetThreadId,
      status: targetStatus,
      statusDetail: null,
    });
  }

  function claimThread(thread, reason, statusOverride = null) {
    setTargetThread(thread, reason, statusOverride);
    claimNewThread = false;
    mark({
      claimNewThread: false,
      threadPinned: true,
      statusDetail: null,
    });
  }

  function disableResumeLog(reason) {
    if (!followResumeLog) {
      return;
    }
    followResumeLog = false;
    mark({ followResumeLog: false, followResumeLogUntil: null });
    appendLine(logFile, `Codex /resume log detection disabled: ${reason}`);
  }

  async function retargetToMatchingThread(threadId, reason, statusOverride = null) {
    if (!followCwdThread || !threadId || threadId === targetThreadId) {
      return false;
    }
    const thread = await readLoadedThreadForCwd(client, threadId, state.cwd, logFile);
    if (!thread) {
      return false;
    }
    if (isThreadReservedByOtherClaimSession(name, state, thread)) {
      appendLine(logFile, `skip ${reason} retarget to thread ${thread.id}: reserved by another claim-new-thread session`);
      return false;
    }
    setTargetThread(thread, reason, statusOverride);
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      await sendHeartbeat(`queued-after-${reason}`);
    }
    return true;
  }

  async function retargetFromRecentThreadList() {
    if (!shouldUseRecentThreadListFallback({ followCwdThread, codexResumeLogEnabled })) {
      return false;
    }

    const candidate = await findRecentThreadListCandidateForCwd(client, state.cwd, {
      afterUpdatedAt: recentThreadListAfterUpdatedAt,
      currentThreadId: targetThreadId,
      handledThreadIds: handledRecentThreadListIds,
    });
    if (!candidate) {
      return false;
    }

    recentThreadListAfterUpdatedAt = Math.max(recentThreadListAfterUpdatedAt, Number(candidate.updatedAt ?? 0));
    handledRecentThreadListIds.add(candidate.id);
    appendLine(logFile, `found recent same-cwd thread ${candidate.id} in thread/list; resuming through app-server`);

    const thread = await resumeThreadForCwd(client, candidate.id, state.cwd);
    if (!thread) {
      appendLine(logFile, `thread/list candidate ${candidate.id} did not resume into cwd ${state.cwd}`);
      return false;
    }

    setTargetThread(thread, 'thread-list-resume');
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      await sendHeartbeat('queued-after-thread-list-resume');
    }
    return true;
  }

  async function retargetFromCodexResumeLog() {
    if ((!followCwdThread && !followResumeLog) || !codexResumeLogEnabled) {
      return false;
    }
    if (followResumeLog && Number.isFinite(followResumeLogUntil) && Date.now() > followResumeLogUntil) {
      disableResumeLog('settle window expired');
      if (!followCwdThread) {
        return false;
      }
    }

    let rows;
    try {
      rows = readCodexResumeLogRows({ afterId: codexResumeLogLastSeenId });
    } catch (error) {
      codexResumeLogEnabled = false;
      appendLine(
        logFile,
        `Codex /resume log detection disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    let retargeted = false;
    for (const row of rows) {
      codexResumeLogLastSeenId = Math.max(codexResumeLogLastSeenId, row.id);
      const threadId = extractResumeThreadId(row);
      if (!threadId || threadId === targetThreadId) {
        continue;
      }
      appendLine(logFile, `detected Codex /resume log for thread ${threadId}`);
      const didRetarget = followCwdThread
        ? await retargetToMatchingThread(threadId, 'codex-resume-log')
        : await retargetToResumeLogThread(threadId);
      if (!didRetarget) {
        appendLine(logFile, `Codex /resume log thread ${threadId} is not a loaded match for cwd ${state.cwd}`);
      }
      retargeted = retargeted || didRetarget;
    }
    return retargeted;
  }

  async function retargetToResumeLogThread(threadId) {
    if (!followResumeLog || !threadId) {
      return false;
    }
    const thread = await readLoadedThreadForCwd(client, threadId, state.cwd, logFile);
    if (!thread) {
      return false;
    }
    setTargetThread(thread, 'codex-resume-log');
    claimNewThread = false;
    disableResumeLog('retargeted to resumed thread');
    mark({
      claimNewThread: false,
      threadPinned: true,
      statusDetail: null,
    });
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      await sendHeartbeat('queued-after-codex-resume-log');
    }
    return true;
  }

  client.on('thread/status/changed', (params) => {
    if (params?.threadId !== targetThreadId) {
      retargetToMatchingThread(params?.threadId, 'status-event', params?.status?.type ?? null).catch((error) => {
        appendLine(logFile, `status-event retarget failed: ${error instanceof Error ? error.message : String(error)}`);
      });
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

  client.on('thread/started', (params) => {
    const thread = params?.thread;
    if (claimNewThread) {
      if (!thread?.id || thread.cwd !== state.cwd || thread.status?.type === 'notLoaded') {
        return;
      }
      const createdAt = Number(thread.createdAt ?? thread.updatedAt ?? 0);
      if (createdAt < claimThreadAfter) {
        return;
      }
      claimThread(thread, 'started-event');
      return;
    }
    if (!followCwdThread || !thread?.id || thread.id === targetThreadId) {
      return;
    }
    if (thread.cwd !== state.cwd || thread.status?.type === 'notLoaded') {
      return;
    }
    if (isThreadReservedByOtherClaimSession(name, state, thread)) {
      appendLine(logFile, `skip started-event thread ${thread.id}: reserved by another claim-new-thread session`);
      return;
    }
    setTargetThread(thread, 'started-event');
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

  if (followCwdThread || followResumeLog) {
    const savedHighWatermark = Number(state.followResumeLogHighWatermark);
    if (followResumeLog && Number.isFinite(savedHighWatermark) && savedHighWatermark >= 0) {
      codexResumeLogEnabled = true;
      codexResumeLogLastSeenId = Math.floor(savedHighWatermark);
      appendLine(logFile, `Codex /resume log detection enabled from launch log id ${codexResumeLogLastSeenId}`);
    } else {
      const resumeLog = readCodexLogHighWatermark();
      if (resumeLog.ok) {
        codexResumeLogEnabled = true;
        codexResumeLogLastSeenId = resumeLog.lastSeenId;
        appendLine(logFile, `Codex /resume log detection enabled from log id ${codexResumeLogLastSeenId}`);
      } else {
        appendLine(logFile, `Codex /resume log detection disabled: ${resumeLog.reason}`);
      }
    }
  }

  await refreshTarget();

  scheduleNextHeartbeat(Date.now());

  if (state.immediate) {
    await sendHeartbeat(state.once ? 'once' : 'immediate');
  }

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

    await retargetFromRecentThreadList().catch((error) => {
      appendLine(logFile, `thread-list retarget failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await retargetFromCodexResumeLog().catch((error) => {
      appendLine(logFile, `Codex /resume log retarget failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await refreshTarget();
    if (targetStatus === 'idle' && queuedHeartbeat) {
      queuedHeartbeat = false;
      await sendHeartbeat('queued-after-poll-idle');
    }

    if (hasTriggerMarker(name)) {
      clearTriggerMarker(name);
      appendLine(logFile, 'manual trigger marker found');
      await sendHeartbeat('manual-trigger');
      continue;
    }

    if (!state.once && Date.now() >= nextHeartbeatAt) {
      const sent = await sendHeartbeat('interval');
      if (!sent && !queuedHeartbeat) {
        scheduleNextHeartbeat(Date.now());
      }
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
