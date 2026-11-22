// Archives a session in OpenCode at a given time (epoch ms). A fork module:
// OpenCode takes the time as `experimental.archivedAt` beside `archived: true`
// (developing-today-forks/opencode#2686), and the @opencode/client this
// package pins encodes session.update through its schema, which drops that
// field, so the request is sent as plain JSON. An OpenCode without the field
// ignores it and archives at its own time; the migration reads the time back
// to tell the two apart.

import { z } from 'zod';
import { readBoundedResponseText } from '../shared/response-body.js';

const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const sessionNotFoundBody = z.object({ _tag: z.literal('SessionNotFoundError') });

interface ArchiveAtOptions {
  baseUrl: () => string;
  headers: () => HeadersInit;
  fetchImpl?: typeof fetch;
}

export const createOpenCodeArchiveAt = ({ baseUrl, headers, fetchImpl = fetch }: ArchiveAtOptions) => async (sessionID: string, archivedAt: number) => {
  const response = await fetchImpl(`${baseUrl()}/api/session/${encodeURIComponent(sessionID)}`, {
    method: 'PATCH',
    headers: { ...Object.fromEntries(new Headers(headers())), 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true, experimental: { archivedAt } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const body = await readBoundedResponseText(response, ERROR_BODY_MAX_BYTES);
  // Only OpenCode's own answer that the session does not exist counts as
  // "missing"; any other 404 (a location, a route) is a failure that keeps the entry.
  if (!body.tooLarge && sessionNotFoundBody.safeParse(parseJson(body.text)).success) {
    throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: 'SessionNotFoundError' });
  }
  throw new Error(`OpenCode answered ${response.status} to the archive update`);
};

const parseJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
