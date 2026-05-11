import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SQLITE_SEPARATOR = '\x1f';
const RESUME_LOG_TARGET = 'codex_app_server::request_processors::thread_lifecycle';
const RESUME_LOG_MARKER = 'composing running thread resume response';

function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexLogDatabasePath(env = process.env) {
  return path.join(codexHome(env), 'logs_2.sqlite');
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function sqliteText(value) {
  return String(value ?? '').replaceAll("'", "''");
}

function defaultSqlitePath() {
  return process.env.SQLITE3_PATH || (fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3');
}

function runSqlite(dbPath, sql, sqlitePath = 'sqlite3') {
  return execFileSync(
    sqlitePath,
    ['-readonly', '-batch', '-separator', SQLITE_SEPARATOR, dbPath, sql],
    {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export function readCodexLogHighWatermark({ dbPath = codexLogDatabasePath(), sqlitePath = defaultSqlitePath() } = {}) {
  if (!fs.existsSync(dbPath)) {
    return { ok: false, lastSeenId: 0, reason: `Codex log database not found at ${dbPath}` };
  }

  try {
    const output = runSqlite(dbPath, 'select coalesce(max(id), 0) from logs;', sqlitePath).trim();
    return { ok: true, lastSeenId: positiveInteger(output, 0) };
  } catch (error) {
    return {
      ok: false,
      lastSeenId: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extractResumeThreadId(row) {
  if (row?.threadId) {
    return row.threadId;
  }
  const match = String(row?.body ?? '').match(/\bthread_id=([0-9a-f-]{36})\b/i);
  return match?.[1] ?? null;
}

export function parseResumeLogRows(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, threadId, body] = line.split(SQLITE_SEPARATOR);
      return {
        id: positiveInteger(id, 0),
        threadId: threadId || null,
        body: body ?? '',
      };
    })
    .filter((row) => row.id > 0 && extractResumeThreadId(row));
}

export function readCodexResumeLogRows({
  dbPath = codexLogDatabasePath(),
  sqlitePath = defaultSqlitePath(),
  afterId = 0,
  limit = 25,
} = {}) {
  const safeAfterId = positiveInteger(afterId, 0);
  const safeLimit = Math.max(1, Math.min(100, positiveInteger(limit, 25)));
  const safeTarget = sqliteText(RESUME_LOG_TARGET);
  const safeMarker = sqliteText(`%${RESUME_LOG_MARKER}%`);
  const sql = `
select
  id,
  coalesce(thread_id, ''),
  replace(replace(coalesce(feedback_log_body, ''), char(10), ' '), char(13), ' ')
from logs
where id > ${safeAfterId}
  and target = '${safeTarget}'
  and feedback_log_body like '${safeMarker}'
order by id asc
limit ${safeLimit};
`;

  const output = runSqlite(dbPath, sql, sqlitePath);
  return parseResumeLogRows(output);
}
