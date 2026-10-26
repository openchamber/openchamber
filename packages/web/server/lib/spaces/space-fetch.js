// A `fetch` for the host's own reads about a space's session: what a notification needs to say
// about a chat of a space (its title, its parent, its last reply, its running subagents) is
// known only to the OpenCode inside that space, so the host asks there, over the dispatcher's
// channel, and never asks its own OpenCode about a session that is not its own.
//
// Everything that comes back is untrusted: only a `GET` under `/api/session` goes in, and an
// answer is read up to a cap and within one deadline for the whole read, so a space that answers
// slowly, or stops in the middle of an answer, fails the read instead of holding it.

const SESSION_PATH = '/api/session';
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;

const isSessionPath = (pathname) => pathname === SESSION_PATH || pathname.startsWith(`${SESSION_PATH}/`);

/** Rejects when `signal` aborts, with its reason; `settle` ends the wait. */
const abortOf = (signal) => {
  let settle = () => {};
  const promise = new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    settle = () => signal.removeEventListener('abort', onAbort);
  });
  promise.catch(() => {});
  return { promise, settle };
};

// A body from inside, read up to a cap; an answer that closes before its end is a failure.
const readBody = (response, cap) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let ended = false;
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > cap) { response.destroy(); reject(new Error(`the answer exceeds ${cap} bytes`)); return; }
    chunks.push(chunk);
  });
  response.on('end', () => { ended = true; resolve(Buffer.concat(chunks).toString('utf8')); });
  response.on('error', reject);
  response.on('close', () => { if (!ended) reject(new Error('the answer closed before its end')); });
});

/**
 * `requestInside` is the dispatcher's. Returns `fetchFor(spaceId)`, a `fetch` that answers a
 * standard `Response`: the inside's status and body for a `200`, the status alone otherwise.
 * A refused path, a dead channel, an answer past the cap, past `timeoutMs` for the whole read or
 * past the caller's own signal rejects, as a failed `fetch` does.
 */
export function createSpaceFetch({ requestInside, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return (spaceId) => async (url, { method = 'GET', signal } = {}) => {
    const { pathname, search } = new URL(url);
    if (method !== 'GET' || !isSessionPath(pathname)) {
      throw new Error(`a space is asked only to read its sessions, not ${method} ${pathname}`);
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    stop.throwIfAborted();
    const aborted = abortOf(stop);
    const request = requestInside(spaceId, { path: `${pathname}${search}`, headers: { accept: 'application/json' }, timeoutMs });
    // An answer that arrives after the deadline is closed unread.
    request.then((late) => { if (stop.aborted) late.destroy(); }, () => {});
    try {
      const response = await Promise.race([request, aborted.promise]);
      stop.addEventListener('abort', () => response.destroy(), { once: true });
      if (response.statusCode !== 200) {
        response.resume();
        const status = response.statusCode >= 200 && response.statusCode <= 599 ? response.statusCode : 502;
        return new Response(null, { status });
      }
      const body = await Promise.race([readBody(response, maxBytes), aborted.promise]);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } finally {
      aborted.settle();
    }
  };
}
