import http from 'node:http';

/**
 * The callback listener: the one way a host-spawned extension service calls
 * OpenChamber back. A plain Node HTTP server on `127.0.0.1:0`, started on
 * first use and kept apart from the Express app on purpose: nothing that
 * reaches the app (the relay, tunnels, UI auth, a LAN bind) reaches this
 * port, and nothing registered on the app is served here.
 *
 * Each route is `POST <path>` with a JSON body and `Authorization: Bearer
 * <capability>`; the route's owner decides what the bearer means (a
 * source-control call's outbound handle, `source-control/outbound-handles.js`)
 * and is asked whether it admits the bearer before any body is read
 * (`refusal(bearer)`: the answer that turns it away, or null), so an unknown
 * caller cannot make the host buffer a body.
 * Answers are JSON: whatever the route returns, or `{ error: { message, code } }`
 * when the listener refuses the request itself.
 */

// A forge request body is at most 1 MB of text; as a JSON string it can grow
// to six bytes a character (`\u0000`), and the envelope adds a little.
const REQUEST_BODY_MAX = 6_200_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** @typedef {{ refusal: (bearer: string) => { status: number, body: unknown } | null, serve: (request: { bearer: string, body: unknown }) => Promise<{ status: number, body: unknown }> }} HostCallbackRoute */
/** @type {Map<string, HostCallbackRoute>} */
const routes = new Map();
/** @type {Promise<{ server: http.Server, url: string }> | null} */
let listening = null;

const refuse = (status, code, message) => ({ status, body: { error: { message, code } } });

const send = (response, { status, body }, done) => {
  const text = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (done) headers.connection = 'close';
  response.writeHead(status, headers);
  response.end(text, done);
};

/**
 * The body as text, or null as soon as it grows past the cap. Nothing past
 * the cap is read: the caller answers and then cuts the connection.
 */
const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const onData = (chunk) => {
    size += chunk.length;
    if (size <= REQUEST_BODY_MAX) {
      chunks.push(chunk);
      return;
    }
    request.off('data', onData);
    request.pause();
    resolve(null);
  };
  request.on('data', onData);
  request.on('end', () => resolve(Buffer.concat(chunks, size).toString('utf8')));
  request.on('error', reject);
});

const answer = async (request) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const route = routes.get(path);
  if (!route) return refuse(404, 'NOT_FOUND', 'Unknown callback route');
  if (request.method !== 'POST') return refuse(405, 'BAD_METHOD', 'Callback routes take POST');
  // A web page can address a loopback port; only a process the host started
  // calls this listener, and it sends no Origin.
  if (request.headers.origin !== undefined) return refuse(403, 'BAD_ORIGIN', 'Browsers cannot call this listener');
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!bearer) return refuse(401, 'HANDLE_UNKNOWN', 'A bearer is required');
  const refused = route.refusal(bearer);
  if (refused) return { ...refused, close: true };
  const text = await readBody(request);
  // The rest of the body is not read: the connection is cut once this is sent.
  if (text === null) return { ...refuse(413, 'BODY_TOO_LARGE', 'The request body is too large'), close: true };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'BAD_REQUEST', 'The request body is not JSON');
  }
  return route.serve({ bearer, body });
};

const startListener = () => new Promise((resolve, reject) => {
  const server = http.createServer((request, response) => {
    answer(request).then(
      (result) => send(response, result, result.close ? () => request.destroy() : undefined),
      () => send(response, refuse(500, 'HOST_FAILED', 'OpenChamber could not handle the request')),
    );
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    // The listener never keeps the host process alive on its own.
    server.unref();
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
});

/**
 * Serves `path` with `route` (`refusal(bearer)` before the body is read, then
 * `serve`); replaces an earlier route for the path. Returns a function that
 * removes this route again.
 * @param {string} path
 * @param {HostCallbackRoute} route
 */
export const setHostCallbackRoute = (path, route) => {
  routes.set(path, route);
  return () => {
    if (routes.get(path) === route) routes.delete(path);
  };
};

/** The listener's base URL (`http://127.0.0.1:<port>`), starting it on first use. */
export const hostCallbackUrl = async () => {
  listening ??= startListener().catch((error) => {
    listening = null;
    throw error;
  });
  return (await listening).url;
};

/** Stops the listener; the next `hostCallbackUrl` starts a new one on a new port. */
export const stopHostCallbackListener = async () => {
  const current = listening;
  listening = null;
  if (!current) return;
  const { server } = await current.catch(() => ({ server: null }));
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
};
