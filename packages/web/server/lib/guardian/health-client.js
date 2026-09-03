import net from 'node:net';
import tls from 'node:tls';

import {
  createManagedOpenCodeHealthChallenge,
  createManagedOpenCodeHealthProof,
  MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER,
  MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER,
  MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER,
  MANAGED_OPENCODE_HEALTH_OWNER_HEADER,
  MANAGED_OPENCODE_HEALTH_PORT_HEADER,
  MANAGED_OPENCODE_HEALTH_PROOF_HEADER,
  MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER,
  verifyManagedOpenCodeHealthProof,
} from './health-proof.js';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CRLF = Buffer.from('\r\n', 'ascii');
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

const isSafeHeaderValue = (value) => typeof value === 'string'
  && !/[\r\n]/.test(value)
  && Buffer.byteLength(value, 'utf8') <= 64 * 1024;

const headerValue = (headers, name) => headers[name.toLowerCase()] ?? null;

const parseChunkedBody = (buffer, offset) => {
  let cursor = offset;
  const chunks = [];

  while (true) {
    const lineEnd = buffer.indexOf(CRLF, cursor);
    if (lineEnd === -1) return null;
    const line = buffer.toString('ascii', cursor, lineEnd);
    const sizeText = line.split(';', 1)[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
      throw new Error('Managed health response contained an invalid chunk size');
    }
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES) {
      throw new Error('Managed health response body is too large');
    }
    cursor = lineEnd + CRLF.length;
    if (size === 0) {
      const trailersEnd = buffer.subarray(cursor, cursor + CRLF.length).equals(CRLF)
        ? cursor
        : buffer.indexOf(HEADER_END, cursor);
      if (trailersEnd === -1) return null;
      const body = Buffer.concat(chunks);
      return {
        body,
        consumed: trailersEnd + (trailersEnd === cursor ? CRLF.length : HEADER_END.length),
      };
    }

    if (buffer.length < cursor + size + CRLF.length) return null;
    const chunkEnd = cursor + size;
    if (!buffer.subarray(chunkEnd, chunkEnd + CRLF.length).equals(CRLF)) {
      throw new Error('Managed health response contained an invalid chunk terminator');
    }
    chunks.push(buffer.subarray(cursor, chunkEnd));
    cursor = chunkEnd + CRLF.length;
    if (chunks.reduce((total, chunk) => total + chunk.length, 0) > MAX_RESPONSE_BYTES) {
      throw new Error('Managed health response body is too large');
    }
  }
};

const parseHttpResponse = (buffer) => {
  if (buffer.length > MAX_RESPONSE_BYTES + HEADER_END.length) {
    throw new Error('Managed health response is too large');
  }
  const headerEnd = buffer.indexOf(HEADER_END);
  if (headerEnd === -1) return null;

  const headerText = buffer.toString('latin1', 0, headerEnd);
  const lines = headerText.split('\r\n');
  const statusMatch = lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/);
  if (!statusMatch) throw new Error('Managed health response status line was malformed');

  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('Managed health response header was malformed');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!name || !isSafeHeaderValue(value)) {
      throw new Error('Managed health response header was malformed');
    }
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }

  const bodyOffset = headerEnd + HEADER_END.length;
  const transferEncoding = headerValue(headers, 'transfer-encoding')?.toLowerCase() || '';
  let bodyResult;
  if (transferEncoding.split(',').map((value) => value.trim()).includes('chunked')) {
    bodyResult = parseChunkedBody(buffer, bodyOffset);
    if (!bodyResult) return null;
  } else {
    const contentLength = headerValue(headers, 'content-length');
    if (!/^\d+$/.test(contentLength || '')) {
      throw new Error('Managed health response must have a bounded body');
    }
    const length = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
      throw new Error('Managed health response body is too large');
    }
    if (buffer.length < bodyOffset + length) return null;
    bodyResult = {
      body: buffer.subarray(bodyOffset, bodyOffset + length),
      consumed: bodyOffset + length,
    };
  }

  return {
    status: Number.parseInt(statusMatch[1], 10),
    headers,
    body: bodyResult.body,
    consumed: bodyResult.consumed,
  };
};

const parseJsonBody = (body) => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  } finally {
    body.fill(0);
  }
};

const normalizeConnectionHostname = (hostname) => (
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
);

const formatHostHeader = (parsed) => {
  const normalizedHostname = normalizeConnectionHostname(parsed.hostname);
  const hostname = normalizedHostname.includes(':') ? `[${normalizedHostname}]` : normalizedHostname;
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  return parsed.port && parsed.port !== defaultPort ? `${hostname}:${parsed.port}` : hostname;
};

const connect = (parsed, timeoutMs) => new Promise((resolve, reject) => {
  const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  const hostname = normalizeConnectionHostname(parsed.hostname);
  const options = { host: hostname, port };
  const socket = parsed.protocol === 'https:'
    ? tls.connect({ ...options, servername: hostname })
    : net.connect(options);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(new Error('Managed health connection timed out'));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    socket.off('error', onError);
  };
  const onError = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const onConnect = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(socket);
  };
  socket.once('error', onError);
  socket.once(parsed.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
});

const writeRequest = (socket, parsed, headers, timeoutMs) => new Promise((resolve, reject) => {
  const requestHeaders = {
    Host: formatHostHeader(parsed),
    Accept: 'application/json',
    Connection: 'keep-alive',
    ...headers,
  };
  if (Object.entries(requestHeaders).some(([, value]) => !isSafeHeaderValue(value))) {
    reject(new Error('Managed health request header was malformed'));
    return;
  }
  const target = `${parsed.pathname || '/'}${parsed.search || ''}`;
  const request = [
    `GET ${target} HTTP/1.1`,
    ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error('Managed health request timed out'));
  }, timeoutMs);
  const onError = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };
  socket.once('error', onError);
  try {
    socket.write(request, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      resolve();
    });
  } catch (error) {
    socket.off('error', onError);
    clearTimeout(timer);
    reject(error);
  }
});

const readResponse = (socket, initialBuffer, timeoutMs) => new Promise((resolve, reject) => {
  let buffer = initialBuffer;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error('Managed health response timed out'));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    socket.off('data', onData);
    socket.off('close', onClose);
    socket.off('end', onEnd);
    socket.off('error', onError);
  };
  const onClose = () => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error('Managed health connection closed before the response completed'));
  };
  const onEnd = onClose;
  const onError = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const tryParse = () => {
    if (settled) return;
    let parsed;
    try {
      parsed = parseHttpResponse(buffer);
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }
    if (!parsed) return;
    settled = true;
    cleanup();
    resolve({ response: parsed, remaining: buffer.subarray(parsed.consumed) });
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  };
  socket.on('data', onData);
  socket.once('close', onClose);
  socket.once('end', onEnd);
  socket.once('error', onError);
  tryParse();
});

const proofFailure = (reason, status) => ({
  healthy: false,
  credentialProofFailed: true,
  ...(status === undefined ? {} : { status }),
  reason,
});

const credentialFailure = (reason, status) => ({
  healthy: false,
  credentialUnavailable: true,
  ...(status === undefined ? {} : { status }),
  reason,
});

/**
 * Probe a managed child over one TCP/TLS connection.
 *
 * The first request contains no credential. The child returns a nonce-bound
 * proof, and the second request is written to the exact same socket only after
 * that proof verifies. A closed/replaced listener cannot receive the second
 * request because this helper never reconnects between proof and Basic Auth.
 */
export const performConnectionBoundManagedOpenCodeHealth = async ({
  url,
  record,
  credential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  if (!credential || typeof credential.username !== 'string' || typeof credential.password !== 'string') {
    return credentialFailure('managed OpenCode credential is unavailable');
  }

  let parsed;
  let socket;
  let buffer = Buffer.alloc(0);
  let challenge;
  // `proof` is hoisted to the enclosing function scope so the catch below can
  // distinguish a pre-proof connection failure (no proof received yet, return
  // `credentialFailure` without an unhandled ReferenceError) from a post-proof
  // connection failure (proof was issued, fail-closed via `proofFailure`).
  let proof = null;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return proofFailure('managed OpenCode health requires an HTTP connection');
    }
    challenge = createManagedOpenCodeHealthChallenge();
    const proofInput = {
      password: credential.password,
      challenge,
      incarnation: record?.incarnation,
      ownerInstanceId: record?.ownerInstanceId,
      runtimeIdentity: record?.runtimeIdentity,
      launchFingerprint: record?.launchFingerprint,
      port: record?.port,
    };

    socket = await connect(parsed, timeoutMs);
    await writeRequest(socket, parsed, {
      [MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER]: challenge,
      [MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER]: record?.incarnation,
      [MANAGED_OPENCODE_HEALTH_OWNER_HEADER]: record?.ownerInstanceId,
      [MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER]: record?.runtimeIdentity,
      [MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER]: record?.launchFingerprint,
      [MANAGED_OPENCODE_HEALTH_PORT_HEADER]: String(record?.port ?? ''),
    }, timeoutMs);
    const challengeResult = await readResponse(socket, buffer, timeoutMs);
    buffer = challengeResult.remaining;
    const challengeBody = parseJsonBody(challengeResult.response.body);
    proof = challengeResult.response.headers[MANAGED_OPENCODE_HEALTH_PROOF_HEADER.toLowerCase()];
    if (
      challengeResult.response.status < 200
      || challengeResult.response.status >= 300
      || challengeBody?.healthy !== true
      || !verifyManagedOpenCodeHealthProof(proofInput, proof)
    ) {
      return proofFailure(
        'managed OpenCode health proof was unavailable or invalid; refusing to send the managed credential',
        challengeResult.response.status,
      );
    }

    const connectionHeader = challengeResult.response.headers.connection?.toLowerCase() || '';
    if (connectionHeader.includes('close') || socket.destroyed || !socket.writable) {
      return proofFailure(
        'managed OpenCode health proof connection was not reusable; refusing to send the managed credential',
      );
    }

    const encoded = Buffer.from(`${credential.username}:${credential.password}`, 'utf8');
    let authorization;
    try {
      authorization = `Basic ${encoded.toString('base64')}`;
    } finally {
      encoded.fill(0);
    }
    await writeRequest(socket, parsed, {
      Authorization: authorization,
      [MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER]: challenge,
      [MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER]: record?.incarnation,
      [MANAGED_OPENCODE_HEALTH_OWNER_HEADER]: record?.ownerInstanceId,
      [MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER]: record?.runtimeIdentity,
      [MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER]: record?.launchFingerprint,
      [MANAGED_OPENCODE_HEALTH_PORT_HEADER]: String(record?.port ?? ''),
      [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
    }, timeoutMs);
    const authenticatedResult = await readResponse(socket, buffer, timeoutMs);
    const authenticatedBody = parseJsonBody(authenticatedResult.response.body);
    if (authenticatedResult.response.status === 401 || authenticatedResult.response.status === 403) {
      return credentialFailure('managed OpenCode credential was rejected by the child', authenticatedResult.response.status);
    }
    if (authenticatedResult.response.status < 200
      || authenticatedResult.response.status >= 300
      || authenticatedBody?.healthy !== true) {
      return {
        healthy: false,
        status: authenticatedResult.response.status,
        reason: authenticatedBody && typeof authenticatedBody === 'object'
          ? 'managed OpenCode health endpoint reported unhealthy'
          : 'managed OpenCode health endpoint returned malformed data',
      };
    }
    return { healthy: true };
  } catch {
    return proof
      ? proofFailure('managed OpenCode health proof connection failed; refusing to send the managed credential')
      : credentialFailure('managed OpenCode health request failed transiently');
  } finally {
    try { socket?.destroy(); } catch { /* best effort */ }
    buffer.fill(0);
  }
};
