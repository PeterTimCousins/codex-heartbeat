import { readJson, writeJson } from './fs-util.mjs';
import fs from 'node:fs';
import { stateRoot } from './paths.mjs';
import path from 'node:path';

export const DEFAULT_PREFERENCES = {
  serverName: 'default',
  serverUrl: 'ws://127.0.0.1:18654',
  heartbeatIntervalSeconds: 1800,
  codexArgs: '--yolo',
  keepHeartbeat: false,
};

export function preferencesPath() {
  return path.join(stateRoot(), 'preferences.json');
}

export function readPreferences() {
  return {
    ...DEFAULT_PREFERENCES,
    ...readJson(preferencesPath(), {}),
  };
}

export function writePreferences(preferences) {
  writeJson(preferencesPath(), {
    ...DEFAULT_PREFERENCES,
    ...preferences,
  });
}

export function ensurePreferences() {
  if (!fs.existsSync(preferencesPath())) {
    writePreferences(DEFAULT_PREFERENCES);
    return { created: true, preferences: readPreferences(), path: preferencesPath() };
  }
  return { created: false, preferences: readPreferences(), path: preferencesPath() };
}
