import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugifyName } from './fs-util.mjs';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_URL, stateRoot } from './paths.mjs';
import { ensurePreferences, preferencesPath, readPreferences, writePreferences } from './preferences.mjs';
import { serverStatus, startServer, stopServer } from './server-manager.mjs';
import { listSessions, reapManagedState, removeSession, sessionStatus, startSession, stopSession } from './session-manager.mjs';
import { resolveThreadReferenceFromAppServer } from './thread-resolver.mjs';

function usage() {
  return `Usage:
  codex-heartbeat status [--json]
  codex-heartbeat server start [--name default] [--url ws://127.0.0.1:18654] [--foreground]
  codex-heartbeat server stop [--name default]
  codex-heartbeat server status [--name default] [--json]
  codex-heartbeat remote [--server default] [-- <codex args...>]
  codex-heartbeat codex [--server default] [--url ws://127.0.0.1:18654] [--heartbeat-name NAME] [--heartbeat-thread THREAD_ID_OR_NAME] [--heartbeat-thread-name NAME] [--heartbeat-interval SECONDS] [--heartbeat-message TEXT] [--heartbeat-cwd PATH] [--no-heartbeat] [--keep-heartbeat] [codex args...]
  codex-heartbeat session start --name NAME [--server default] [--url URL] [--cwd PATH] [--thread THREAD_ID] [--thread-name NAME] [--initial-thread THREAD_ID] [--interval SECONDS] [--message TEXT] [--immediate] [--once]
  codex-heartbeat session stop --name NAME
  codex-heartbeat session remove --name NAME [--force]
  codex-heartbeat session status --name NAME [--json]
  codex-heartbeat session list [--json]
  codex-heartbeat preferences [--json]
  codex-heartbeat preferences set [--server-name NAME] [--server-url URL] [--heartbeat-interval SECONDS] [--heartbeat-message TEXT] [--heartbeat-thread THREAD_ID_OR_NAME] [--codex-args TEXT] [--launch-app APP] [--keep-heartbeat true|false]
  codex-heartbeat init [--build-menu] [--install-menu] [--json]
  codex-heartbeat doctor [--json]
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
    if (['foreground', 'immediate', 'once', 'json', 'build-menu', 'install-menu', 'force'].includes(key)) {
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

function parseCodexWrapperOptions(argv) {
  const options = {
    server: null,
    url: null,
    heartbeat: true,
    keepHeartbeat: null,
    heartbeatName: null,
    heartbeatThread: null,
    heartbeatThreadName: null,
    heartbeatInterval: null,
    heartbeatMessage: null,
    heartbeatCwd: process.cwd(),
    heartbeatCwdExplicit: false,
    codexArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.codexArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--no-heartbeat') {
      options.heartbeat = false;
      continue;
    }
    if (arg === '--keep-heartbeat') {
      options.keepHeartbeat = true;
      continue;
    }
    if (arg === '--server') {
      options.server = argv[++i];
      if (!options.server) {
        throw new Error('Missing value for --server');
      }
      continue;
    }
    if (arg === '--url') {
      options.url = argv[++i];
      if (!options.url) {
        throw new Error('Missing value for --url');
      }
      continue;
    }
    if (arg === '--heartbeat-name') {
      options.heartbeatName = argv[++i];
      if (!options.heartbeatName) {
        throw new Error('Missing value for --heartbeat-name');
      }
      continue;
    }
    if (arg === '--heartbeat-thread') {
      options.heartbeatThread = argv[++i];
      if (!options.heartbeatThread) {
        throw new Error('Missing value for --heartbeat-thread');
      }
      continue;
    }
    if (arg === '--heartbeat-thread-name') {
      options.heartbeatThreadName = argv[++i];
      if (!options.heartbeatThreadName) {
        throw new Error('Missing value for --heartbeat-thread-name');
      }
      continue;
    }
    if (arg === '--heartbeat-interval') {
      options.heartbeatInterval = argv[++i];
      if (!options.heartbeatInterval) {
        throw new Error('Missing value for --heartbeat-interval');
      }
      continue;
    }
    if (arg === '--heartbeat-message') {
      options.heartbeatMessage = argv[++i];
      if (!options.heartbeatMessage) {
        throw new Error('Missing value for --heartbeat-message');
      }
      continue;
    }
    if (arg === '--heartbeat-cwd') {
      options.heartbeatCwd = argv[++i];
      if (!options.heartbeatCwd) {
        throw new Error('Missing value for --heartbeat-cwd');
      }
      options.heartbeatCwdExplicit = true;
      continue;
    }
    options.codexArgs.push(arg);
  }
  return options;
}

function autoHeartbeatName(cwd) {
  const resolved = path.resolve(cwd);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function hasCodexCwdArg(args) {
  return codexCwdArg(args) !== null;
}

function codexCwdArg(args) {
  let cwd = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-C' || arg === '--cd') {
      if (args[i + 1]) {
        cwd = args[i + 1];
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--cd=')) {
      cwd = arg.slice('--cd='.length);
    }
  }
  return cwd;
}

function effectiveHeartbeatCwd(options) {
  if (options.heartbeatCwdExplicit) {
    return path.resolve(options.heartbeatCwd);
  }
  const codexCwd = codexCwdArg(options.codexArgs);
  return path.resolve(codexCwd ?? options.heartbeatCwd);
}

function childExitCode(code, signal) {
  if (code !== null && code !== undefined) {
    return code;
  }
  const signalExitCodes = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGQUIT: 131,
    SIGTERM: 143,
    SIGKILL: 137,
  };
  return signalExitCodes[signal] ?? 1;
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

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function repoRoot() {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}

function commandResult(command, args = []) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function commandExists(command) {
  return commandResult('/usr/bin/env', ['sh', '-lc', `command -v ${command}`]);
}

function linkedCommandPath() {
  const result = commandExists('codex-heartbeat');
  return result.ok ? result.stdout.split('\n')[0] : null;
}

function installedMenuAppPath() {
  return process.env.CODEX_HEARTBEAT_APP_PATH || path.join(process.env.HOME, 'Applications', 'Codex Heartbeat.app');
}

function doctorStatus() {
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  const codex = commandExists('codex');
  const codexVersion = codex.ok ? commandResult('codex', ['--version']).stdout : null;
  const linkedPath = linkedCommandPath();
  const menuAppPath = path.join(repoRoot(), 'build', 'CodexHeartbeatMenu.app');
  const installedAppPath = installedMenuAppPath();
  return {
    stateRoot: stateRoot(),
    preferencesPath: preferencesPath(),
    node: {
      ok: nodeMajor >= 22,
      version: nodeVersion,
      required: '>=22',
    },
    codex: {
      ok: codex.ok,
      path: codex.ok ? codex.stdout.split('\n')[0] : null,
      version: codexVersion,
    },
    command: {
      ok: Boolean(linkedPath),
      path: linkedPath,
    },
    menuApp: {
      ok: fs.existsSync(menuAppPath),
      path: menuAppPath,
    },
    installedMenuApp: {
      ok: fs.existsSync(installedAppPath),
      path: installedAppPath,
    },
  };
}

function printDoctor(status) {
  console.log('Codex Heartbeat doctor');
  console.log(`  State root: ${status.stateRoot}`);
  console.log(`  Preferences: ${status.preferencesPath}`);
  console.log(`  Node: ${status.node.ok ? 'ok' : 'missing/old'} (${status.node.version}, requires ${status.node.required})`);
  console.log(`  Codex CLI: ${status.codex.ok ? 'ok' : 'missing'}${status.codex.path ? ` (${status.codex.path})` : ''}`);
  if (status.codex.version) {
    console.log(`  Codex version: ${status.codex.version}`);
  }
  console.log(`  codex-heartbeat on PATH: ${status.command.ok ? 'yes' : 'no'}${status.command.path ? ` (${status.command.path})` : ''}`);
  console.log(`  Menu app built: ${status.menuApp.ok ? 'yes' : 'no'} (${status.menuApp.path})`);
  console.log(`  Menu app installed: ${status.installedMenuApp.ok ? 'yes' : 'no'} (${status.installedMenuApp.path})`);
}

function fullStatus() {
  const preferences = readPreferences();
  return {
    stateRoot: stateRoot(),
    preferences,
    server: serverStatus(preferences.serverName, preferences.serverUrl),
    sessions: listSessions(),
  };
}

function printSession(session) {
  console.log(`Session: ${session.name}`);
  console.log(`  Status: ${session.status}${session.running ? ' (process running)' : ''}`);
  console.log(`  Server: ${session.serverName ?? 'external'}`);
  console.log(`  URL: ${session.url}`);
  console.log(`  CWD: ${session.cwd}`);
  console.log(`  Target: ${session.threadPinned ? 'pinned thread' : 'latest loaded thread for cwd'}`);
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

async function runCodex(argv) {
  const options = parseCodexWrapperOptions(argv);
  const preferences = readPreferences();
  const serverName = options.server ?? preferences.serverName;
  const requestedUrl = options.url ?? preferences.serverUrl;
  const heartbeatInterval = options.heartbeatInterval ?? preferences.heartbeatIntervalSeconds;
  const heartbeatMessage = options.heartbeatMessage ?? preferences.heartbeatMessage;
  const heartbeatThread = options.heartbeatThread ?? preferences.heartbeatThread;
  const keepHeartbeat = options.keepHeartbeat ?? preferences.keepHeartbeat;
  const heartbeatCwd = effectiveHeartbeatCwd(options);
  const existing = serverStatus(serverName);
  let url;

  if (existing.running) {
    if (options.url && existing.url !== options.url) {
      throw new Error(`Server ${serverName} is already running at ${existing.url}, not ${options.url}`);
    }
    url = existing.url;
  } else {
    const started = await startServer({ name: serverName, url: requestedUrl });
    url = started.state?.url ?? requestedUrl;
    console.log(`Started app-server ${started.state.name} with pid ${started.state.pid}`);
    console.log(`URL: ${url}`);
    console.log(`Ready: ${started.ready?.ok ? 'yes' : `not confirmed (${started.ready?.readyUrl})`}`);
  }

  const heartbeatName = options.heartbeatName ?? autoHeartbeatName(heartbeatCwd);
  let heartbeatStarted = false;
  let heartbeatCleaned = false;
  let child;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const signalHandlers = new Map();
  function cleanupHeartbeat(reason) {
    if (!options.heartbeat || !heartbeatStarted || keepHeartbeat || heartbeatCleaned) {
      return;
    }
    heartbeatCleaned = true;
    const result = stopSession(heartbeatName, reason);
    console.log(result.stopped ? `Stopped heartbeat session ${heartbeatName}` : result.message);
  }
  function removeSignalHandlers() {
    for (const [signal, handler] of signalHandlers.entries()) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  }

  for (const signal of signals) {
    const handler = () => {
      cleanupHeartbeat(`codex-wrapper-${signal.toLowerCase()}`);
      if (child && !child.killed) {
        child.kill(signal);
      }
      process.exit(signalExitCodes[signal]);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  if (options.heartbeat) {
    const heartbeatThreadId = await resolveHeartbeatThreadId(url, { ...options, heartbeatThread });
    const result = await startSession({
      name: heartbeatName,
      cwd: heartbeatCwd,
      threadId: heartbeatThreadId,
      intervalSeconds: heartbeatInterval,
      message: heartbeatMessage,
      url,
      serverName,
    });
    heartbeatStarted = result.started;
    console.log(
      result.started
        ? `Started heartbeat session ${result.state.name} with pid ${result.state.pid}`
        : result.message,
    );
  }

  const codexArgs = hasCodexCwdArg(options.codexArgs)
    ? options.codexArgs
    : ['-C', heartbeatCwd, ...options.codexArgs];

  try {
    child = spawn('codex', ['--remote', url, ...codexArgs], {
      cwd: options.heartbeatCwd,
      stdio: 'inherit',
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    removeSignalHandlers();
    cleanupHeartbeat('codex-wrapper-exit');
    process.exit(childExitCode(result.code, result.signal));
  } catch (error) {
    removeSignalHandlers();
    cleanupHeartbeat('codex-wrapper-spawn-error');
    throw error;
  }
}

async function resolveHeartbeatThreadId(url, options) {
  if (options.heartbeatThreadName) {
    return resolveThreadReferenceFromAppServer(url, options.heartbeatThreadName, { nameOnly: true });
  }
  if (options.heartbeatThread) {
    return resolveThreadReferenceFromAppServer(url, options.heartbeatThread);
  }
  return null;
}

async function serverUrlForThreadResolution(options) {
  if (options.url) {
    return options.url;
  }
  const serverName = options.server ?? 'default';
  const existing = serverStatus(serverName);
  if (existing.running) {
    return existing.url;
  }
  if (serverName !== 'default') {
    throw new Error(`Server ${serverName} is not running. Start it before resolving --thread-name.`);
  }
  const started = await startServer({ name: serverName, url: DEFAULT_URL });
  return started.state?.url ?? DEFAULT_URL;
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
    if (options.json) {
      printJson(serverStatus(name));
      return;
    }
    printServerStatus(serverStatus(name));
    return;
  }
  throw new Error(`Unknown server command: ${command}`);
}

async function runSession(command, argv) {
  const options = parseOptions(argv);
  if (command === 'start') {
    const preferences = readPreferences();
    let threadId = options.thread ?? null;
    let url = options.url;
    if (options['thread-name']) {
      url = await serverUrlForThreadResolution(options);
      threadId = await resolveThreadReferenceFromAppServer(url, options['thread-name'], {
        nameOnly: true,
      });
    }
    const result = await startSession({
      name: options.name,
      cwd: options.cwd,
      threadId,
      initialThreadId: options['initial-thread'] ?? null,
      intervalSeconds: options.interval ?? preferences.heartbeatIntervalSeconds,
      message: options.message ?? preferences.heartbeatMessage,
      once: options.once,
      immediate: options.immediate,
      url,
      serverName: options.server,
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
  if (command === 'remove' || command === 'delete') {
    if (!options.name) {
      throw new Error('--name is required');
    }
    const result = removeSession(options.name, { force: Boolean(options.force) });
    console.log(result.removed ? `Removed heartbeat session ${result.name}` : result.message);
    return;
  }
  if (command === 'status') {
    if (!options.name) {
      throw new Error('--name is required');
    }
    const session = sessionStatus(options.name);
    if (options.json) {
      printJson(session ?? { name: options.name, found: false });
      return;
    }
    if (!session) {
      console.log(`Session ${options.name} not found`);
      return;
    }
    printSession(session);
    return;
  }
  if (command === 'list') {
    const sessions = listSessions();
    if (options.json) {
      printJson({ sessions });
      return;
    }
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

function parseBoolean(value) {
  if (value === 'true' || value === 'yes' || value === '1') {
    return true;
  }
  if (value === 'false' || value === 'no' || value === '0') {
    return false;
  }
  throw new Error('Boolean values must be true or false');
}

function runPreferences(command, argv) {
  const commandIsOption = command?.startsWith('--');
  const options = parseOptions(commandIsOption ? [command, ...argv] : argv);
  const action = commandIsOption ? null : command;
  if (!action || action === 'show') {
    const preferences = readPreferences();
    if (options.json) {
      printJson({ path: preferencesPath(), preferences });
    } else {
      console.log(`Preferences: ${preferencesPath()}`);
      console.log(`  Server: ${preferences.serverName}`);
      console.log(`  URL: ${preferences.serverUrl}`);
      console.log(`  Interval: ${preferences.heartbeatIntervalSeconds}s`);
      console.log(`  Heartbeat message: ${preferences.heartbeatMessage}`);
      console.log(`  Heartbeat thread: ${preferences.heartbeatThread || '(auto)'}`);
      console.log(`  Codex args: ${preferences.codexArgs}`);
      console.log(`  Launch app: ${preferences.launchApp}`);
      console.log(`  Keep heartbeat: ${preferences.keepHeartbeat ? 'yes' : 'no'}`);
    }
    return;
  }
  if (action === 'set') {
    const preferences = readPreferences();
    if (options['server-name']) {
      preferences.serverName = slugifyName(options['server-name']);
    }
    if (options['server-url']) {
      preferences.serverUrl = options['server-url'];
    }
    if (options['heartbeat-interval']) {
      const interval = Number(options['heartbeat-interval']);
      if (!Number.isFinite(interval) || interval < 1) {
        throw new Error('--heartbeat-interval must be a positive number of seconds');
      }
      preferences.heartbeatIntervalSeconds = interval;
    }
    if (options['heartbeat-message'] !== undefined) {
      if (!options['heartbeat-message']) {
        throw new Error('--heartbeat-message cannot be empty');
      }
      preferences.heartbeatMessage = options['heartbeat-message'];
    }
    if (options['heartbeat-thread'] !== undefined) {
      preferences.heartbeatThread = options['heartbeat-thread'];
    }
    if (options['codex-args'] !== undefined) {
      preferences.codexArgs = options['codex-args'];
    }
    if (options['launch-app'] !== undefined) {
      if (!options['launch-app'].trim()) {
        throw new Error('--launch-app cannot be empty');
      }
      preferences.launchApp = options['launch-app'].trim();
    }
    if (options['keep-heartbeat'] !== undefined) {
      preferences.keepHeartbeat = parseBoolean(options['keep-heartbeat']);
    }
    writePreferences(preferences);
    if (options.json) {
      printJson({ path: preferencesPath(), preferences });
    } else {
      console.log(`Updated preferences: ${preferencesPath()}`);
    }
    return;
  }
  throw new Error(`Unknown preferences command: ${action}`);
}

function runScript(scriptName, args = []) {
  const scriptPath = path.join(repoRoot(), 'scripts', scriptName);
  const result = spawnSync(scriptPath, args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${scriptName} failed`);
  }
  return result.stdout?.trim() ?? '';
}

function runDoctor(argv) {
  const options = parseOptions(argv);
  const status = doctorStatus();
  if (options.json) {
    printJson(status);
  } else {
    printDoctor(status);
  }
  return status;
}

function runInit(argv) {
  const options = parseOptions(argv);
  const preferences = ensurePreferences();
  const actions = [
    {
      name: 'preferences',
      ok: true,
      detail: `${preferences.created ? 'created' : 'exists'} ${preferences.path}`,
    },
  ];

  if (options['build-menu']) {
    const output = runScript('build-menu-bar.sh');
    actions.push({ name: 'build-menu', ok: true, detail: output });
  }

  if (options['install-menu']) {
    const output = runScript('install-menu-app.sh');
    actions.push({ name: 'install-menu', ok: true, detail: output });
  }

  const status = doctorStatus();
  const result = { actions, doctor: status };
  if (options.json) {
    printJson(result);
    return;
  }

  console.log('Codex Heartbeat init');
  for (const action of actions) {
    console.log(`  ${action.name}: ${action.detail}`);
  }
  console.log('');
  printDoctor(status);
  console.log('');
  console.log('Next steps:');
  if (!status.command.ok) {
    console.log('  1. Link the CLI: npm link');
    console.log('  2. Start Codex with heartbeat: codex-heartbeat codex --yolo');
  } else {
    console.log('  Start Codex with heartbeat: codex-heartbeat codex --yolo');
  }
  console.log('  Menu app: npm run menu');
}

export async function runCli(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(usage());
    return;
  }
  if (command === 'status') {
    const options = parseOptions([subcommand, ...rest].filter(Boolean));
    if (options.json) {
      printJson(fullStatus());
      return;
    }
    const preferences = readPreferences();
    printServerStatus(serverStatus(preferences.serverName, preferences.serverUrl));
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
  if (command === 'preferences') {
    runPreferences(subcommand, rest);
    return;
  }
  if (command === 'doctor') {
    runDoctor([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === 'init') {
    runInit([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === 'remote') {
    await runRemote([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === 'codex') {
    await runCodex([subcommand, ...rest].filter(Boolean));
    return;
  }
  if (command === 'reap') {
    const result = reapManagedState();
    console.log(
      result.reapedSessions.length === 0
        ? 'No stale sessions found.'
        : `Marked stale sessions: ${result.reapedSessions.join(', ')}`,
    );
    if (result.stoppedServers?.length > 0) {
      console.log(`Stopped managed app-server(s) with no running heartbeat sessions: ${result.stoppedServers.join(', ')}`);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
