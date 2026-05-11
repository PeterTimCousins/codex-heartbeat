import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, ensureDir } from './fs-util.mjs';

export function isPidRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function terminatePid(pid) {
  if (!isPidRunning(pid)) {
    return false;
  }
  process.kill(Number(pid), 'SIGTERM');
  return true;
}

export function spawnDetached(command, args, { cwd, logFile, env = process.env } = {}) {
  ensureDir(path.dirname(logFile));
  const output = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', output, output],
  });
  child.unref();
  fs.closeSync(output);
  return child.pid;
}

export async function waitForReadyz(url, logFile, attempts = 10) {
  const readyUrl = `${url.replace(/^ws:/, 'http:').replace(/\/$/, '')}/readyz`;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(readyUrl);
      if (response.ok) {
        return { ok: true, readyUrl };
      }
    } catch (error) {
      appendLine(logFile, `ready check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, readyUrl };
}
