'use strict';


const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');

const [bindArgument, corridorPort, windowPort, controlPort, windowDeadline, corridorCap, windowCap, controlCap] = process.argv.slice(2);

const cap = (given, production) => (Number.isInteger(Number(given)) && Number(given) > 0 ? Number(given) : production);
const CONTROL_HOST = '127.0.0.1';

const ALLOWED_PORT = 443;
const ALWAYS_REFUSED = ['auth.openai.com'];

const MAX_TUNNELS = 64;
const MAX_CORRIDOR_CONNECTIONS = cap(corridorCap, 2 * MAX_TUNNELS);
const MAX_WINDOW_CONNECTIONS = cap(windowCap, 64);
const WINDOW_IDLE_MS = Number(windowDeadline) > 0 ? Number(windowDeadline) : 300_000;
const MAX_CONTROL_CONNECTIONS = cap(controlCap, 8);
const NOTE_INTERVAL_MS = 60_000;
const TUNNEL_IDLE_MS = 300_000;
const CONNECT_TIMEOUT_MS = 15_000;

const MAX_HEADER_BYTES = 16 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_BODY_BYTES = 1024 * 1024;

const JOURNAL_RECORDS = 500;
const MAX_JOURNAL_HOST = 256;
const MAX_JOURNAL_DECISION = 64;
const MAX_ALLOWED_DOMAINS = 500;

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NUMERIC_LABEL = /^(\d+|0x[0-9a-f]+)$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SECRET_LENGTH = 8192;
const MAX_GRANT_HEADERS = 32;
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]+$/;
const RESERVED_HEADER_NAMES = ['host', 'content-length', 'transfer-encoding', 'connection', 'te', 'upgrade', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key', 'proxy-authorization'];

function readBindHost(argument) {
  const given = String(argument ?? '');
  let text = given;
  if (given.startsWith('/')) {
    try {
      text = fs.readFileSync(given, 'utf8').trim();
    } catch (error) {
      console.error(`gatekeeper: cannot read the bind address from ${given} (${error.code || error.message})`);
      process.exit(2);
    }
  }
  if (net.isIP(text) === 0 || text === '0.0.0.0' || text === '::') {
    console.error(`gatekeeper: ${given} is not the address of one interface`);
    process.exit(2);
  }
  return text;
}
let networkMode = 'allowlist';
let allowedDomains = new Set();
const grants = new Map();

const STARTED_AT = new Date().toISOString();
const journal = [];
let journalDropped = 0;

function record(listener, host, port, decision) {
  journal.push({
    at: new Date().toISOString(),
    listener,
    host: String(host || '').slice(0, MAX_JOURNAL_HOST),
    port: Number(port) || 0,
    decision: String(decision).slice(0, MAX_JOURNAL_DECISION),
  });
  if (journal.length > JOURNAL_RECORDS) {
    journal.shift();
    journalDropped += 1;
  }
}


function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIPv6(text) {
  const address = String(text).split('%')[0];
  if (!address.includes(':')) return null;
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;
  const readGroups = (part) => {
    if (part === undefined || part === '') return [];
    const groups = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (index === pieces.length - 1 && piece.includes('.')) {
        const embedded = parseIPv4(piece);
        if (!embedded) return null;
        groups.push(embedded[0] * 256 + embedded[1], embedded[2] * 256 + embedded[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const left = readGroups(head);
  const right = tail === undefined ? [] : readGroups(tail);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...new Array(tail === undefined ? 0 : missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function blockedIPv4(bytes) {
  const [a, b, c] = bytes;
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function embeddedIPv4(bytes) {
  const zeros = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zeros(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0 && !zeros(12, 16)))) {
    return bytes.slice(12, 16);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return bytes.slice(12, 16);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return bytes.slice(2, 6);
  }
  return null;
}

function blockedIPv6(bytes) {
  const embedded = embeddedIPv4(bytes);
  if (embedded) return blockedIPv4(embedded);
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

function isBlockedAddress(text) {
  const v4 = parseIPv4(text);
  if (v4) return blockedIPv4(v4);
  const v6 = parseIPv6(text);
  if (v6) return blockedIPv6(v6);
  return true;
}

const lookupAll = (host) => new Promise((resolve) => {
  dns.lookup(host, { all: true, verbatim: true }, (error, answers) => {
    if (error || !Array.isArray(answers) || answers.length === 0) {
      resolve({ addresses: [], reason: error ? String(error.code || error.message) : 'no address' });
      return;
    }
    resolve({ addresses: answers, reason: '' });
  });
});

const chooseAddress = (addresses) => addresses.find((answer) => answer.family === 4) ?? addresses[0];

async function resolveAllowedAddress(host) {
  const { addresses, reason } = await lookupAll(host);
  if (addresses.length === 0) return { error: `unresolved:${reason}` };
  if (addresses.some((answer) => isBlockedAddress(answer.address))) return { error: 'blocked-address' };
  const chosen = chooseAddress(addresses);
  return { address: chosen.address, family: chosen.family };
}

const fixedLookup = (address, family) => (hostname, options, callback) => {
  if (options && options.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};


function splitTarget(text) {
  const value = String(text || '');
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  let host = value.slice(0, separator);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length === 0 || host.length > 255) return null;
  if (/[\s/@]/.test(host)) return null;
  return { host, port };
}

const normalizeName = (host) => String(host).trim().toLowerCase().replace(/\.$/, '');

function refuseTarget(host, port) {
  const name = normalizeName(host);
  if (ALWAYS_REFUSED.includes(name)) return 'deny:always-refused';
  if (parseIPv4(name) || parseIPv6(name) || !isDomainName(name)) return 'deny:not-a-name';
  if (port !== ALLOWED_PORT) return 'deny:port';
  if (networkMode === 'open') return null;
  return allowedDomains.has(name) ? null : 'deny:not-on-allowlist';
}

const isDomainName = (name) => DOMAIN_PATTERN.test(name) && !NUMERIC_LABEL.test(name.slice(name.lastIndexOf('.') + 1));

let openTunnels = 0;

const MAX_LINGERING_REFUSALS = 16;
const lingeringRefusals = new Set();

const REFUSED = 'refused';
const UNREACHABLE = 'unreachable';

function refuse(socket, status, text, reason) {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nx-gatekeeper-reason: ${reason}\r\nConnection: close\r\n\r\n`);
    socket.resume();
    const release = () => { lingeringRefusals.delete(socket); if (!socket.destroyed) socket.destroySoon(); };
    lingeringRefusals.add(socket);
    socket.on('close', () => lingeringRefusals.delete(socket));
    socket.on('error', release);
    socket.on('end', release);
    while (lingeringRefusals.size > MAX_LINGERING_REFUSALS) {
      const oldest = lingeringRefusals.values().next().value;
      lingeringRefusals.delete(oldest);
      oldest.destroy();
    }
  } catch {
    socket.destroy();
  }
}

async function openTunnel(request, clientSocket, head) {
  clientSocket.on('error', () => {});
  let release = () => {};
  const clientLeft = () => release();
  clientSocket.on('close', clientLeft);
  clientSocket.on('end', clientLeft);

  const target = splitTarget(request.url);
  if (!target) {
    record('corridor', '', 0, 'deny:malformed');
    refuse(clientSocket, 400, 'Bad Request', REFUSED);
    return;
  }
  const { host, port } = target;
  const refusal = refuseTarget(host, port);
  if (refusal) {
    record('corridor', normalizeName(host), port, refusal);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  if (openTunnels >= MAX_TUNNELS) {
    record('corridor', normalizeName(host), port, 'deny:too-many-tunnels');
    refuse(clientSocket, 503, 'Service Unavailable', REFUSED);
    return;
  }
  openTunnels += 1;
  let counted = true;
  const releasePlace = () => {
    if (counted) {
      counted = false;
      openTunnels -= 1;
    }
  };
  release = releasePlace;

  const resolved = await resolveAllowedAddress(normalizeName(host));
  if (resolved.error) {
    releasePlace();
    record('corridor', normalizeName(host), port, `deny:${resolved.error}`);
    refuse(clientSocket, 403, 'Forbidden', REFUSED);
    return;
  }
  record('corridor', normalizeName(host), port, 'allow');

  const upstream = net.connect({ host: resolved.address, port, allowHalfOpen: true });
  const abort = () => {
    releasePlace();
    upstream.destroy();
    clientSocket.destroy();
  };
  let carrying = false;
  upstream.on('error', (error) => {
    const code = String(error.code || 'error').slice(0, 32);
    record('corridor', normalizeName(host), port, `failed:${code}`);
    if (!carrying && !clientSocket.destroyed && !clientSocket.writableEnded) {
      refuse(clientSocket, 502, 'Bad Gateway', UNREACHABLE);
      releasePlace();
      upstream.destroy();
      return;
    }
    abort();
  });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, abort);
  upstream.on('connect', () => {
    upstream.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.setTimeout(TUNNEL_IDLE_MS, abort);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    carrying = true;
    release = () => {};
    joinSockets(clientSocket, upstream, releasePlace);
  });
  release = abort;
  if (clientSocket.destroyed || clientSocket.readableEnded) abort();
}

function joinSockets(clientSocket, upstream, done) {
  let closed = 0;
  const bothGone = () => {
    closed += 1;
    if (closed >= 2) done();
  };
  const follow = (peer) => () => {
    if (!peer.destroyed) peer.destroySoon();
    bothGone();
  };
  upstream.on('close', follow(clientSocket));
  clientSocket.on('close', follow(upstream));
  upstream.pipe(clientSocket);
  clientSocket.pipe(upstream);
}

function refusePlainProxy(request, response) {
  let host = '';
  try {
    host = normalizeName(new URL(request.url).hostname);
  } catch {
    host = '';
  }
  record('corridor', host, 0, 'deny:not-connect');
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end('{"error":"the corridor takes CONNECT only"}');
}


const WINDOW_PATH = /^\/model\/([A-Za-z0-9._-]{1,64})([/?][^]*)?$/;

function walksOutOfGrant(rest) {
  let form = String(rest ?? '');
  for (;;) {
    if (form.split(/[/\\;?#]/).includes('..')) return true;
    if (!form.includes('%')) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return true;
    }
    if (decoded === form) return false;
    form = decoded;
  }
}

const agentOptions = { keepAlive: false, maxSockets: MAX_WINDOW_CONNECTIONS, maxTotalSockets: MAX_WINDOW_CONNECTIONS };
const windowAgents = { 'http:': new http.Agent(agentOptions), 'https:': new https.Agent(agentOptions) };

const answerJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const ownListenerPorts = new Set([Number(corridorPort), Number(windowPort), Number(controlPort)]);
const ownAddresses = new Set(Object.values(os.networkInterfaces())
  .flat()
  .filter(Boolean)
  .map((entry) => String(entry.address).toLowerCase()));

function isLoopback(address) {
  const v4 = parseIPv4(address);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const embedded = embeddedIPv4(v6);
  if (embedded) return embedded[0] === 127;
  return v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1;
}

const isOwnListener = (address, port) => (isLoopback(address) || ownAddresses.has(String(address).toLowerCase())) && ownListenerPorts.has(Number(port));

async function serveWindow(request, response) {
  request.on('error', () => {});
  const match = WINDOW_PATH.exec(request.url || '');
  if (match && walksOutOfGrant(match[2] || '')) {
    record('window', 'grant-path', 0, 'deny:path-walks-out');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }
  const grant = match ? grants.get(match[1]) : null;
  if (!grant) {
    record('window', 'unknown-grant', 0, 'deny:no-grant');
    answerJson(response, 403, { error: 'no such grant' });
    return;
  }

  const upstream = new URL(grant.upstream);
  const port = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  if (ALWAYS_REFUSED.includes(normalizeName(upstream.hostname))) {
    record('window', normalizeName(upstream.hostname), port, 'deny:always-refused');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }
  const resolved = await lookupAll(upstream.hostname);
  if (resolved.addresses.length === 0) {
    record('window', normalizeName(upstream.hostname), port, `deny:unresolved:${resolved.reason}`);
    answerJson(response, 502, { error: 'the upstream of this grant does not resolve' });
    return;
  }
  const chosen = chooseAddress(resolved.addresses);
  if (isOwnListener(chosen.address, port)) {
    record('window', normalizeName(upstream.hostname), port, 'deny:own-listener');
    answerJson(response, 403, { error: 'refused destination' });
    return;
  }

  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (['authorization', 'x-api-key', 'x-goog-api-key', 'proxy-authorization'].includes(lower) || lower === grant.header) delete headers[name];
  }
  headers.host = upstream.host;
  if (grant.secret !== null) {
    headers[grant.header] = grant.header === 'authorization' ? `Bearer ${grant.secret}` : grant.secret;
  }
  Object.assign(headers, grant.headers);

  record('window', normalizeName(upstream.hostname), port, 'allow');
  const transport = upstream.protocol === 'https:' ? https : http;
  const outgoing = transport.request({
    hostname: upstream.hostname,
    port,
    method: request.method,
    path: upstream.pathname.replace(/\/$/, '') + (match[2] || ''),
    headers,
    agent: windowAgents[upstream.protocol],
    lookup: fixedLookup(chosen.address, chosen.family),
  }, (answer) => {
    response.writeHead(answer.statusCode || 502, answer.headers);
    answer.on('error', () => { response.destroy(); });
    answer.pipe(response);
  });
  let given = false;
  outgoing.setTimeout(WINDOW_IDLE_MS, () => {
    given = true;
    record('window', normalizeName(upstream.hostname), port, 'failed:timeout');
    if (!response.headersSent) answerJson(response, 504, { error: 'the upstream did not answer in time' });
    else response.destroy();
    outgoing.destroy();
  });
  outgoing.on('error', (error) => {
    if (given) return;
    given = true;
    const code = String(error.code || 'error').slice(0, 32);
    record('window', normalizeName(upstream.hostname), port, `failed:${code}`);
    if (!response.headersSent) answerJson(response, 502, { error: 'the upstream did not answer' });
    else response.destroy();
  });
  response.on('close', () => {
    if (!response.writableFinished) outgoing.destroy();
  });
  request.pipe(outgoing);
}


const readBody = (request) => new Promise((resolve) => {
  let text = '';
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    text += chunk;
    if (text.length > CONTROL_BODY_BYTES) {
      tooLarge = true;
      text = '';
    }
  });
  request.on('error', () => resolve(null));
  request.on('end', () => resolve(tooLarge ? null : text));
});

const asText = (value) => (value === null || value === undefined || value instanceof Object ? '' : String(value));

function setNetwork(body) {
  if (body.mode !== 'allowlist' && body.mode !== 'open') return 'mode is "allowlist" or "open"';
  const domains = Array.isArray(body.domains) ? body.domains : [];
  if (domains.length > MAX_ALLOWED_DOMAINS) return `at most ${MAX_ALLOWED_DOMAINS} domains`;
  const names = domains.map((domain) => normalizeName(asText(domain)));
  const wrong = names.find((name) => !isDomainName(name) || parseIPv4(name) || parseIPv6(name));
  if (wrong !== undefined) return `'${wrong}' is not a domain name. The allowlist holds exact names, no wildcards and no addresses.`;
  networkMode = body.mode;
  allowedDomains = new Set(names);
  return null;
}

function grantHeadersOf(value) {
  if (value === undefined) return { headers: {} };
  if (value === null || !(value instanceof Object) || Array.isArray(value)) return { refusal: 'the headers of a grant are an object of names to text' };
  const entries = Object.entries(value);
  if (entries.length > MAX_GRANT_HEADERS) return { refusal: `at most ${MAX_GRANT_HEADERS} headers on a grant` };
  const headers = {};
  for (const [name, text] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(lower)) return { refusal: 'a header name is 1 to 64 letters, digits or dashes' };
    if (RESERVED_HEADER_NAMES.includes(lower)) return { refusal: `the header '${lower}' is the window's own` };
    const asString = asText(text);
    if (asString.length === 0 || asString.length > MAX_SECRET_LENGTH) return { refusal: 'a header of a grant is text, 1 to 8192 characters' };
    if (!HEADER_VALUE_PATTERN.test(asString)) return { refusal: 'a header of a grant is Latin-1 text without line breaks' };
    headers[lower] = asString;
  }
  return { headers };
}

function addGrant(body) {
  const id = asText(body.id);
  if (!GRANT_ID_PATTERN.test(id)) return 'a grant id is 1 to 64 letters, digits, dots, dashes or underscores';
  const withSecret = body.secret !== undefined || body.header !== undefined;
  const header = withSecret ? asText(body.header).toLowerCase() : null;
  const secret = withSecret ? asText(body.secret) : null;
  if (withSecret && !HEADER_NAME_PATTERN.test(header)) return 'a header name is 1 to 64 letters, digits or dashes';
  if (withSecret && (secret.length === 0 || secret.length > MAX_SECRET_LENGTH)) return 'a grant with a header needs a secret';
  const extra = grantHeadersOf(body.headers);
  if (extra.refusal) return extra.refusal;
  if (header !== null && header in extra.headers) return `the header '${header}' carries the secret and cannot be set twice`;
  let upstream;
  try {
    upstream = new URL(asText(body.upstream));
  } catch {
    return 'the upstream of a grant is a URL';
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return 'the upstream of a grant is http or https';
  grants.set(id, { upstream: upstream.toString(), header, secret, headers: extra.headers });
  return null;
}

async function serveControl(request, response) {
  request.on('error', () => {});
  const path = String(request.url || '').split('?')[0];
  if (request.method === 'GET' && path === '/health') {
    answerJson(response, 200, { ready: true, mode: networkMode, domains: allowedDomains.size, grants: grants.size });
    return;
  }
  if (request.method === 'GET' && path === '/policy') {
    answerJson(response, 200, { mode: networkMode, domains: Array.from(allowedDomains), grants: Array.from(grants.keys()) });
    return;
  }
  if (request.method === 'GET' && path === '/journal') {
    answerJson(response, 200, { records: journal.slice(), dropped: journalDropped, since: STARTED_AT });
    return;
  }
  if (request.method !== 'POST' || (path !== '/network' && path !== '/grants')) {
    answerJson(response, 404, { error: 'no such control endpoint' });
    return;
  }
  const text = await readBody(request);
  let body = null;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    answerJson(response, 400, { error: 'the body is not JSON' });
    return;
  }
  if (!(body instanceof Object) || Array.isArray(body)) {
    answerJson(response, 400, { error: 'the body is not an object' });
    return;
  }
  const problem = path === '/network' ? setNetwork(body) : addGrant(body);
  if (problem) answerJson(response, 400, { error: problem });
  else answerJson(response, 200, { ok: true });
}


let listening = false;
const lastNote = new Map();

function noteRefusedTraffic(listener, decision) {
  const key = `${listener}:${decision}`;
  const last = lastNote.get(key) ?? 0;
  if (Date.now() - last < NOTE_INTERVAL_MS) return;
  lastNote.set(key, Date.now());
  record(listener, '', 0, decision);
}

function makeServer(listener, maxConnections, handler) {
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler);
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = maxConnections;
  server.on('drop', () => noteRefusedTraffic(listener, 'deny:too-many-connections'));
  server.on('clientError', (error, socket) => {
    if (error?.code !== 'ECONNRESET' && error?.code !== 'EPIPE') noteRefusedTraffic(listener, 'deny:unreadable-request');
    if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('error', (error) => {
    console.error(`gatekeeper: listener error ${error.code || error.message}`);
    if (!listening) process.exit(1);
  });
  return server;
}

const corridor = makeServer('corridor', MAX_CORRIDOR_CONNECTIONS, refusePlainProxy);
corridor.on('connect', (request, socket, head) => {
  openTunnel(request, socket, head).catch(() => { socket.destroy(); });
});
const windowServer = makeServer('window', MAX_WINDOW_CONNECTIONS, (request, response) => {
  serveWindow(request, response).catch(() => {
    if (!response.headersSent) answerJson(response, 502, { error: 'the window could not serve this request' });
    else response.destroy();
  });
});
const control = makeServer('control', MAX_CONTROL_CONNECTIONS, (request, response) => {
  serveControl(request, response).catch(() => {
    if (!response.headersSent) answerJson(response, 500, { error: 'the control channel could not serve this request' });
    else response.destroy();
  });
});

const listen = (server, port, host) => new Promise((resolve) => { server.listen(Number(port), host, resolve); });

async function main() {
  const bindHost = readBindHost(bindArgument);
  if (!bindHost || !corridorPort || !windowPort || !controlPort) {
    console.error('gatekeeper: arguments are <bind host> <corridor port> <window port> <control port>');
    process.exit(2);
  }
  await listen(corridor, corridorPort, bindHost);
  await listen(windowServer, windowPort, bindHost);
  await listen(control, controlPort, CONTROL_HOST);
  listening = true;
  process.on('uncaughtException', (error) => {
    console.error(`gatekeeper: kept running after ${describeFailure(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`gatekeeper: kept running after a rejected promise, ${describeFailure(reason)}`);
  });
  console.log(`gatekeeper: corridor ${corridorPort}, window ${windowPort}, control ${CONTROL_HOST}:${controlPort}`);
}

function describeFailure(error) {
  if (!(error instanceof Error)) return 'something that is not an error';
  const frame = String(error.stack ?? '').split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return `${error.name}${error.code ? ` (${error.code})` : ''}${frame ? ` ${frame.trim()}` : ''}`;
}

if (require.main === module) {
  main();
} else {
  module.exports = { addGrant, chooseAddress, isBlockedAddress, isDomainName, joinSockets, parseIPv4, parseIPv6, refuseTarget, setNetwork, splitTarget, walksOutOfGrant };
}
