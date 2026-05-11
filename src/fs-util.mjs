import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) {
    return fallback;
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) {
    return fallback;
  }
  return JSON.parse(text);
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

export function fileTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

export function slugifyName(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('A non-empty session name is required.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error('Session names may only contain letters, numbers, dot, underscore, and dash.');
  }
  return value;
}
