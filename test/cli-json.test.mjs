import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'codex-heartbeat.mjs');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-heartbeat-cli-test-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withHomeAsync(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-heartbeat-cli-test-'));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runJson(args, home) {
  const output = runText(args, home);
  return JSON.parse(output);
}

function runText(args, home, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env, CODEX_HEARTBEAT_HOME: home },
    encoding: 'utf8',
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function spawnKeeper() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
    function check(data) {
      output += data.toString();
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    }
    child.stdout.on('data', check);
    child.stderr.on('data', check);
  });
}

test('status --json reports state root, default server, and sessions', () => {
  withHome((home) => {
    const status = runJson(['status', '--json'], home);
    assert.equal(status.stateRoot, home);
    assert.equal(status.server.name, 'default');
    assert.equal(status.server.running, false);
    assert.deepEqual(status.sessions, []);
  });
});

test('session list --json reports a sessions array', () => {
  withHome((home) => {
    const status = runJson(['session', 'list', '--json'], home);
    assert.deepEqual(status, { sessions: [] });
  });
});

test('preferences set and preferences --json round trip', () => {
  withHome((home) => {
    runJson(
      [
        'preferences',
        'set',
        '--server-name',
        'main',
        '--server-url',
        'ws://127.0.0.1:19999',
        '--heartbeat-interval',
        '900',
        '--heartbeat-message',
        'Custom heartbeat text',
        '--codex-args',
        '--yolo --model test',
        '--keep-heartbeat',
        'true',
        '--json',
      ],
      home,
    );
    const status = runJson(['preferences', '--json'], home);
    assert.equal(status.preferences.serverName, 'main');
    assert.equal(status.preferences.serverUrl, 'ws://127.0.0.1:19999');
    assert.equal(status.preferences.heartbeatIntervalSeconds, 900);
    assert.equal(status.preferences.heartbeatMessage, 'Custom heartbeat text');
    assert.equal(status.preferences.codexArgs, '--yolo --model test');
    assert.equal(status.preferences.keepHeartbeat, true);
  });
});

test('init --json creates preferences and reports diagnostics', () => {
  withHome((home) => {
    const result = runJson(['init', '--json'], home);
    assert.equal(result.actions[0].name, 'preferences');
    assert.equal(result.actions[0].ok, true);
    assert.equal(result.doctor.stateRoot, home);
    assert.equal(fs.existsSync(path.join(home, 'preferences.json')), true);
  });
});

test('doctor --json reports install checks', () => {
  withHome((home) => {
    const result = runJson(['doctor', '--json'], home);
    assert.equal(result.stateRoot, home);
    assert.equal(result.node.ok, true);
    assert.equal(typeof result.codex.ok, 'boolean');
    assert.equal(typeof result.command.ok, 'boolean');
  });
});

test('status --json reports the configured server', () => {
  withHome((home) => {
    runJson(
      ['preferences', 'set', '--server-name', 'main', '--server-url', 'ws://127.0.0.1:19999', '--json'],
      home,
    );
    const status = runJson(['status', '--json'], home);
    assert.equal(status.server.name, 'main');
    assert.equal(status.server.url, 'ws://127.0.0.1:19999');
  });
});

test('preferences set rejects invalid server names before saving', () => {
  withHome((home) => {
    assert.throws(
      () => runText(['preferences', 'set', '--server-name', 'bad/name'], home),
      /letters, numbers, dot, underscore, and dash/,
    );
    const status = runJson(['status', '--json'], home);
    assert.equal(status.server.name, 'default');
  });
});

test('session remove deletes saved session state through the documented command', () => {
  withHome((home) => {
    writeJson(path.join(home, 'sessions', 'old-session', 'session.json'), {
      name: 'old-session',
      url: 'ws://127.0.0.1:19010',
      cwd: repoRoot,
      intervalSeconds: 60,
      status: 'stopped',
    });

    const output = runText(['session', 'remove', '--name', 'old-session'], home);
    assert.match(output, /Removed heartbeat session old-session/);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 'old-session')), false);
  });
});

test('codex wrapper does not stop an existing heartbeat it did not start', () => {
  withHome((home) => {
    const keeper = spawnKeeper();
    try {
      writeJson(path.join(home, 'servers', 'default', 'server.json'), {
        name: 'default',
        url: 'ws://127.0.0.1:19011',
        pid: keeper.pid,
        managed: true,
        commandFragment: '',
      });
      writeJson(path.join(home, 'sessions', 'existing', 'session.json'), {
        name: 'existing',
        url: 'ws://127.0.0.1:19011',
        serverName: 'default',
        cwd: repoRoot,
        intervalSeconds: 60,
        pid: keeper.pid,
        status: 'idle',
        commandFragment: '',
      });

      const binDir = path.join(home, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeCodex = path.join(binDir, 'codex');
      fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakeCodex, 0o755);

      runText(
        ['codex', '--heartbeat-name', 'existing', '--url', 'ws://127.0.0.1:19011', '--yolo'],
        home,
        { PATH: `${binDir}:${process.env.PATH}` },
      );

      assert.equal(isPidRunning(keeper.pid), true);
    } finally {
      keeper.kill('SIGKILL');
    }
  });
});

test('codex wrapper uses Codex cwd argument for heartbeat target', () => {
  withHome((home) => {
    const keeper = spawnKeeper();
    const project = path.join(home, 'project-from-codex-cwd');
    fs.mkdirSync(project, { recursive: true });
    try {
      writeJson(path.join(home, 'servers', 'default', 'server.json'), {
        name: 'default',
        url: 'ws://127.0.0.1:19013',
        pid: keeper.pid,
        managed: true,
        commandFragment: '',
      });

      const binDir = path.join(home, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeCodex = path.join(binDir, 'codex');
      fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakeCodex, 0o755);

      runText(
        ['codex', '--heartbeat-name', 'cwd-target', '--url', 'ws://127.0.0.1:19013', '-C', project, '--yolo'],
        home,
        { PATH: `${binDir}:${process.env.PATH}` },
      );

      const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'cwd-target', 'session.json'), 'utf8'));
      assert.equal(state.cwd, project);
    } finally {
      keeper.kill('SIGKILL');
    }
  });
});

test('codex wrapper stops a heartbeat it started when interrupted', async () => {
  await withHomeAsync(async (home) => {
    const keeper = spawnKeeper();
    let wrapper = null;
    try {
      writeJson(path.join(home, 'servers', 'default', 'server.json'), {
        name: 'default',
        url: 'ws://127.0.0.1:19012',
        pid: keeper.pid,
        managed: true,
        commandFragment: '',
      });

      const binDir = path.join(home, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeCodex = path.join(binDir, 'codex');
      fs.writeFileSync(fakeCodex, '#!/bin/sh\nsleep 30\n');
      fs.chmodSync(fakeCodex, 0o755);

      wrapper = spawn(
        process.execPath,
        [cliPath, 'codex', '--heartbeat-name', 'interrupted', '--url', 'ws://127.0.0.1:19012', '--yolo'],
        {
          cwd: repoRoot,
          env: { ...process.env, CODEX_HEARTBEAT_HOME: home, PATH: `${binDir}:${process.env.PATH}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      await waitForOutput(wrapper, /Started heartbeat session interrupted/);
      wrapper.kill('SIGTERM');
      const result = await waitForProcessExit(wrapper);
      assert.equal(result.code === 143 || result.signal === 'SIGTERM', true);
      assert.equal(fs.existsSync(path.join(home, 'sessions', 'interrupted', 'stop')), true);
      const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'interrupted', 'session.json'), 'utf8'));
      assert.equal(state.status, 'stopped');
    } finally {
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill('SIGKILL');
      }
      keeper.kill('SIGKILL');
    }
  });
});

test('codex wrapper reports child signal exits as failures', () => {
  withHome((home) => {
    const keeper = spawnKeeper();
    try {
      writeJson(path.join(home, 'servers', 'default', 'server.json'), {
        name: 'default',
        url: 'ws://127.0.0.1:19014',
        pid: keeper.pid,
        managed: true,
        commandFragment: '',
      });

      const binDir = path.join(home, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeCodex = path.join(binDir, 'codex');
      fs.writeFileSync(fakeCodex, '#!/bin/sh\nkill -KILL $$\n');
      fs.chmodSync(fakeCodex, 0o755);

      assert.throws(
        () =>
          runText(
            ['codex', '--no-heartbeat', '--url', 'ws://127.0.0.1:19014', '--yolo'],
            home,
            { PATH: `${binDir}:${process.env.PATH}` },
          ),
        (error) => error.status === 137,
      );
    } finally {
      keeper.kill('SIGKILL');
    }
  });
});
