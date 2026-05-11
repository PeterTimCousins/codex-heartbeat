import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findUnpinnedCwdConflict, reapManagedState, removeSession, sessionStatus, startSession } from '../src/session-manager.mjs';
import { compareThreadRecency, findLoadedThreadForCwd, shouldFollowCwdThread } from '../src/session-runner.mjs';
import { serverStatus, stopServer } from '../src/server-manager.mjs';
import { writeServerState, writeSessionState } from '../src/state.mjs';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-heartbeat-test-'));
  process.env.CODEX_HEARTBEAT_HOME = home;
  return home;
}

function cleanupHome(home) {
  delete process.env.CODEX_HEARTBEAT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
}

function spawnLongRunningProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}

test('stopServer refuses to terminate an unmanaged recorded pid', () => {
  const home = makeHome();
  try {
    writeServerState('external', {
      name: 'external',
      url: 'ws://127.0.0.1:19999',
      pid: process.pid,
      managed: false,
    });

    const result = stopServer({ name: 'external' });
    assert.equal(result.stopped, false);
    assert.match(result.message, /not manager-owned/);
  } finally {
    cleanupHome(home);
  }
});

test('server names are path-safe', () => {
  const home = makeHome();
  try {
    assert.throws(() => serverStatus('../bad'), /letters, numbers, dot, underscore, and dash/);
  } finally {
    cleanupHome(home);
  }
});

test('reapManagedState marks stale sessions and stops all idle managed servers', async () => {
  const home = makeHome();
  const idleServer = spawnLongRunningProcess();
  const busyServer = spawnLongRunningProcess();
  try {
    writeServerState('idle', {
      name: 'idle',
      url: 'ws://127.0.0.1:19001',
      pid: idleServer.pid,
      managed: true,
      commandFragment: '',
    });
    writeServerState('busy', {
      name: 'busy',
      url: 'ws://127.0.0.1:19002',
      pid: busyServer.pid,
      managed: true,
      commandFragment: '',
    });
    writeSessionState('stale-session', {
      name: 'stale-session',
      serverName: 'idle',
      url: 'ws://127.0.0.1:19001',
      cwd: process.cwd(),
      intervalSeconds: 60,
      pid: 999999,
      status: 'running',
    });
    writeSessionState('busy-session', {
      name: 'busy-session',
      serverName: 'busy',
      url: 'ws://127.0.0.1:19002',
      cwd: process.cwd(),
      intervalSeconds: 60,
      pid: process.pid,
      status: 'running',
      commandFragment: '',
    });

    const result = reapManagedState();
    assert.deepEqual(result.reapedSessions, ['stale-session']);
    assert.deepEqual(result.stoppedServers, ['idle']);
    assert.equal(sessionStatus('stale-session').status, 'stale');
  } finally {
    idleServer.kill('SIGKILL');
    busyServer.kill('SIGKILL');
    await Promise.allSettled([waitForExit(idleServer), waitForExit(busyServer)]);
    cleanupHome(home);
  }
});

test('managed server status ignores live pids with the wrong command', () => {
  const home = makeHome();
  try {
    writeServerState('mismatch', {
      name: 'mismatch',
      url: 'ws://127.0.0.1:19998',
      pid: process.pid,
      managed: true,
      commandFragment: 'definitely-not-this-process-command',
    });

    const status = serverStatus('mismatch');
    assert.equal(status.running, false);

    const result = stopServer({ name: 'mismatch' });
    assert.equal(result.stopped, false);
    assert.match(result.message, /not the managed app-server command/);
    assert.equal(serverStatus('mismatch').status, 'stale');
  } finally {
    cleanupHome(home);
  }
});

test('explicit-url sessions do not keep the default managed server alive', async () => {
  const home = makeHome();
  const defaultServer = spawnLongRunningProcess();
  try {
    writeServerState('default', {
      name: 'default',
      url: 'ws://127.0.0.1:19003',
      pid: defaultServer.pid,
      managed: true,
      commandFragment: '',
    });
    writeSessionState('external-session', {
      name: 'external-session',
      serverName: null,
      url: 'ws://127.0.0.1:19997',
      cwd: process.cwd(),
      intervalSeconds: 60,
      pid: process.pid,
      status: 'running',
      commandFragment: '',
    });

    const result = reapManagedState();
    assert.deepEqual(result.stoppedServers, ['default']);
  } finally {
    defaultServer.kill('SIGKILL');
    await waitForExit(defaultServer);
    cleanupHome(home);
  }
});

test('startSession does not auto-start an unnamed-port non-default server', async () => {
  const home = makeHome();
  try {
    await assert.rejects(
      () => startSession({ name: 'needs-server', serverName: 'secondary', cwd: process.cwd() }),
      /Server secondary is not running/,
    );
  } finally {
    cleanupHome(home);
  }
});

test('unpinned sessions follow cwd threads and explicit thread sessions stay pinned', () => {
  assert.equal(shouldFollowCwdThread({ threadId: null }), true);
  assert.equal(shouldFollowCwdThread({ threadId: 'auto-selected-thread', threadPinned: false }), true);
  assert.equal(shouldFollowCwdThread({ threadId: 'explicit-thread', threadPinned: true }), false);
  assert.equal(shouldFollowCwdThread({ threadId: 'legacy-explicit-thread' }), false);
});

test('findLoadedThreadForCwd selects the newest loaded matching cwd thread', async () => {
  const cwd = '/tmp/project-a';
  const threads = new Map([
    ['older', { id: 'older', cwd, updatedAt: 100, status: { type: 'idle' } }],
    ['newer', { id: 'newer', cwd, updatedAt: 200, status: { type: 'idle' } }],
    ['other-cwd', { id: 'other-cwd', cwd: '/tmp/project-b', updatedAt: 300, status: { type: 'idle' } }],
    ['not-loaded', { id: 'not-loaded', cwd, updatedAt: 400, status: { type: 'notLoaded' } }],
  ]);
  const client = {
    async request(method, params) {
      if (method === 'thread/loaded/list') {
        assert.equal(params.limit, 100);
        return { data: [...threads.keys()], nextCursor: null };
      }
      if (method === 'thread/read') {
        return { thread: threads.get(params.threadId) };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const selected = await findLoadedThreadForCwd(client, cwd, null);
  assert.equal(selected.id, 'newer');
});

test('compareThreadRecency falls back to createdAt and thread id when updatedAt ties', () => {
  const threads = [
    { id: '019e17b3-b5b0-7693-b9f5-99510e36a316', updatedAt: 100, createdAt: 100 },
    { id: '019e17bf-dcc7-74d1-8dd3-e7a54aa009d9', updatedAt: 100, createdAt: 100 },
    { id: '019e17aa-2cbb-7592-9efa-303c6311ccf6', updatedAt: 100, createdAt: 99 },
  ];

  threads.sort(compareThreadRecency);
  assert.equal(threads[0].id, '019e17bf-dcc7-74d1-8dd3-e7a54aa009d9');
});

test('running unpinned sessions conflict on the same cwd and app-server url', () => {
  const home = makeHome();
  const cwd = path.resolve('/tmp/project-a');
  try {
    writeSessionState('first', {
      name: 'first',
      url: 'ws://127.0.0.1:19010',
      serverName: 'default',
      cwd,
      intervalSeconds: 60,
      pid: process.pid,
      status: 'idle',
      commandFragment: '',
      threadPinned: false,
    });

    const conflict = findUnpinnedCwdConflict({
      name: 'second',
      cwd,
      url: 'ws://127.0.0.1:19010',
    });
    assert.equal(conflict.name, 'first');
  } finally {
    cleanupHome(home);
  }
});

test('pinned sessions do not conflict with cwd-following sessions', () => {
  const home = makeHome();
  const cwd = path.resolve('/tmp/project-a');
  try {
    writeSessionState('first', {
      name: 'first',
      url: 'ws://127.0.0.1:19010',
      serverName: 'default',
      cwd,
      intervalSeconds: 60,
      pid: process.pid,
      status: 'idle',
      commandFragment: '',
      threadPinned: true,
    });

    const conflict = findUnpinnedCwdConflict({
      name: 'second',
      cwd,
      url: 'ws://127.0.0.1:19010',
    });
    assert.equal(conflict, null);
  } finally {
    cleanupHome(home);
  }
});

test('legacy thread-id sessions do not conflict with cwd-following sessions', () => {
  const home = makeHome();
  const cwd = path.resolve('/tmp/project-a');
  try {
    writeSessionState('first', {
      name: 'first',
      url: 'ws://127.0.0.1:19010',
      serverName: 'default',
      cwd,
      threadId: 'legacy-pinned-thread',
      intervalSeconds: 60,
      pid: process.pid,
      status: 'idle',
      commandFragment: '',
    });

    const conflict = findUnpinnedCwdConflict({
      name: 'second',
      cwd,
      url: 'ws://127.0.0.1:19010',
    });
    assert.equal(conflict, null);
  } finally {
    cleanupHome(home);
  }
});

test('removeSession deletes stopped session state but refuses running sessions without force', () => {
  const home = makeHome();
  try {
    writeSessionState('stopped-session', {
      name: 'stopped-session',
      url: 'ws://127.0.0.1:19010',
      cwd: process.cwd(),
      intervalSeconds: 60,
      pid: 999999,
      status: 'stopped',
    });
    assert.equal(removeSession('stopped-session').removed, true);
    assert.equal(sessionStatus('stopped-session'), null);

    writeSessionState('running-session', {
      name: 'running-session',
      url: 'ws://127.0.0.1:19010',
      cwd: process.cwd(),
      intervalSeconds: 60,
      pid: process.pid,
      status: 'idle',
      commandFragment: '',
    });
    assert.throws(() => removeSession('running-session'), /still running/);
    assert.equal(sessionStatus('running-session').name, 'running-session');
  } finally {
    cleanupHome(home);
  }
});
