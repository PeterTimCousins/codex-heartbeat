import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './fs-util.mjs';
import { serverDir, serversRoot, sessionDir, sessionsRoot } from './paths.mjs';

export function serverStatePath(name = 'default') {
  return path.join(serverDir(name), 'server.json');
}

export function readServerState(name = 'default') {
  return readJson(serverStatePath(name), null);
}

export function writeServerState(name, state) {
  writeJson(serverStatePath(name), state);
}

export function listServerNames() {
  ensureDir(serversRoot());
  return fs
    .readdirSync(serversRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function sessionStatePath(name) {
  return path.join(sessionDir(name), 'session.json');
}

export function sessionStopPath(name) {
  return path.join(sessionDir(name), 'stop');
}

export function readSessionState(name) {
  return readJson(sessionStatePath(name), null);
}

export function writeSessionState(name, state) {
  writeJson(sessionStatePath(name), state);
}

export function deleteSessionState(name) {
  fs.rmSync(sessionDir(name), { recursive: true, force: true });
}

export function updateSessionState(name, updates) {
  const current = readSessionState(name) ?? { name };
  writeSessionState(name, {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

export function listSessionNames() {
  ensureDir(sessionsRoot());
  return fs
    .readdirSync(sessionsRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function writeStopMarker(name, reason = 'manual') {
  ensureDir(sessionDir(name));
  fs.writeFileSync(sessionStopPath(name), `stopped_at=${new Date().toISOString()}\nreason=${reason}\n`);
}

export function clearStopMarker(name) {
  const stopPath = sessionStopPath(name);
  if (fs.existsSync(stopPath)) {
    fs.renameSync(stopPath, path.join(sessionDir(name), `stop.archived.${Date.now()}`));
  }
}

export function hasStopMarker(name) {
  return fs.existsSync(sessionStopPath(name));
}
