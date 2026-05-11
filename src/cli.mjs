import { spawn } from 'node:child_process';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_URL, stateRoot } from './paths.mjs';
import { serverStatus, startServer, stopServer } from './server-manager.mjs';
import { listSessions, reapManagedState, sessionStatus, startSession, stopSession } from './session-manager.mjs';

function usage() {
  return `Usage:
  codex-heartbeat status
  codex-heartbeat server start [--name default] [--url ws://127.0.0.1:18654] [--foreground]
  codex-heartbeat server stop [--name default]
  codex-heartbeat server status [--name default]
  codex-heartbeat remote [--server default] [-- <codex args...>]
  codex-heartbeat session start --name NAME [--cwd PATH] [--thread THREAD_ID] [--interval SECONDS] [--message TEXT] [--immediate] [--once]
  codex-heartbeat session stop --name NAME
  codex-heartbeat session status --name NAME
  codex-heartbeat session list
  codex-heartbeat reap

State root: ${stateRoot()}
Default interval: ${DEFAULT_INTERVAL_SECONDS}s`;
}

function parseOptions(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['foreground', 'immediate', 'once'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[key] = value;
  }
  return options;
}

function printServerStatus(status) {
  console.log(`Server: ${status.name}`);
  console.log(`  URL: ${status.url ?? DEFAULT_URL}`);
  console.log(`  PID: ${status.pid ?? 'none'}`);
  console.log(`  Running: ${status.running ? 'yes' : 'no'}`);
  if (status.logFile) {
    console.log(`  Log: ${status.logFile}`);
  }
}

function printSession(session) {
  console.log(`Session: ${session.name}`);
  console.log(`  Status: ${session.status}${session.running ? ' (process running)' : ''}`);
  console.log(`  URL: ${session.url}`);
  console.log(`  CWD: ${session.cwd}`);
  console.log(`  Thread: ${session.threadId ?? 'not selected'}`);
  console.log(`  Interval: ${session.intervalSeconds}s`);
  console.log(`  PID: ${session.pid ?? 'none'}`);
  if (session.statusDetail) {
    console.log(`  Detail: ${session.statusDetail}`);
  }
  if (session.logFile) {
    console.log(`  Log: ${session.logFile}`);
  }
}

async function runRemote(argv) {
  const options = parseOptions(argv);
  const server = serverStatus(options.server ?? 'default');
  if (!server.running) {
    throw new Error(`Server ${options.server ?? 'default'} is not running. Start it with: codex-heartbeat server start`);
  }
  const child = spawn('codex', ['--remote', server.url, ...options._], {
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  process.exit(code ?? 0);
}

async function runServer(command, argv) {
  const options = parseOptions(argv);
  const name = options.name ?? 'default';
  if (command === 'start') {
    if (options.foreground) {
      const url = options.url ?? DEFAULT_URL;
      const child = spawn('codex', ['app-server', '--listen', url], { stdio: 'inherit' });
      const code = await new Promise((resolve) => child.on('exit', resolve));
      process.exit(code ?? 0);
    }
    const result = await startServer({ name, url: options.url ?? DEFAULT_URL });
    if (result.started) {
      console.log(`Started app-server ${name} with pid ${result.state.pid}`);
      console.log(`URL: ${result.state.url}`);
      console.log(`Log: ${result.state.logFile}`);
      console.log(`Ready: ${result.ready?.ok ? 'yes' : `not confirmed (${result.ready?.readyUrl})`}`);
    } else {
      console.log(result.message);
    }
    return;
  }
  if (command === 'stop') {
    const result = stopServer({ name });
    console.log(result.stopped ? `Stopped app-server ${name}` : result.message ?? `App-server ${name} was not running`);
    return;
  }
  if (command === 'status') {
    printServerStatus(serverStatus(name));
    return;
  }
  throw new Error(`Unknown server command: ${command}`);
}

async function runSession(command, argv) {
  const options = parseOptions(argv);
  if (command === 'start') {
    const result = await startSession({
      name: options.name,
      cwd: options.cwd,
      threadId: options.thread,
      intervalSeconds: options.interval,
      message: options.message,
      once: options.once,
      immediate: options.immediate,
      url: options.url,
      serverName: options.server ?? 'default',
    });
    if (result.started) {
      console.log(`Started heartbeat session ${result.state.name} with pid ${result.state.pid}`);
      console.log(`Thread: ${result.state.threadId ?? 'auto-select loaded thread by cwd'}`);
      console.log(`Interval: ${result.state.intervalSeconds}s`);
      console.log(`Log: ${result.state.logFile}`);
    } else {
      console.log(result.message);
    }
    return;
  }
  if (command === 'stop') {
    if (!options.name) {
      throw new Error('--name is required');
    }
    const result = stopSession(options.name);
    console.log(result.stopped ? `Stopped heartbeat session ${options.name}` : result.message);
    return;
  }
  if (command === 'status') {
    if (!options.name) {
      throw new Error('--name is required');
    }
    const session = sessionStatus(options.name);
    if (!session) {
      console.log(`Session ${options.name} not found`);
      return;
    }
    printSession(session);
    return;
  }
  if (command === 'list') {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No heartbeat sessions found.');
      return;
    }
    for (const session of sessions) {
      printSession(session);
    }
    return;
  }
  throw new Error(`Unknown session command: ${command}`);
}

export async function runCli(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(usage());
    return;
  }
  if (command === 'status') {
    printServerStatus(serverStatus('default'));
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('Sessions: none');
    } else {
      for (const session of sessions) {
        printSession(session);
      }
    }
    return;
  }
  if (command === 'server') {
    await runServer(subcommand, rest);
    return;
  }
  if (command === 'session') {
    await runSession(subcommand, rest);
    return;
  }
  if (command === 'remote') {
    await runRemote([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === 'reap') {
    const result = reapManagedState();
    console.log(
      result.reapedSessions.length === 0
        ? 'No stale sessions found.'
        : `Marked stale sessions: ${result.reapedSessions.join(', ')}`,
    );
    if (result.stoppedServer) {
      console.log('Stopped managed default app-server because no heartbeat sessions are running.');
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
