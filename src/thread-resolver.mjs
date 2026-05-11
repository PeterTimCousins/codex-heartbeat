import { AppServerClient } from './app-server-client.mjs';

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

export function resolveThreadReferenceFromThreads(threads, reference, { nameOnly = false } = {}) {
  if (!reference) {
    throw new Error('Thread reference is required');
  }

  if (!nameOnly) {
    const byId = threads.find((thread) => thread?.id === reference);
    if (byId) {
      return byId.id;
    }
    if (isUuidLike(reference)) {
      return reference;
    }
  }

  const matches = threads.filter((thread) => thread?.name === reference);
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length > 1) {
    throw new Error(`Multiple threads are named "${reference}". Use the thread id instead.`);
  }
  throw new Error(`No thread named "${reference}" was found in app-server thread/list.`);
}

export async function resolveThreadReferenceFromAppServer(url, reference, { nameOnly = false } = {}) {
  if (!nameOnly && isUuidLike(reference)) {
    return reference;
  }

  const client = new AppServerClient(url);
  await client.connect();
  try {
    await client.initialize('codex-heartbeat-thread-resolver');
    const threads = await listThreads(client);
    return resolveThreadReferenceFromThreads(threads, reference, { nameOnly });
  } finally {
    client.close();
  }
}
