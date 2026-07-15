import crypto from 'node:crypto';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { RelayCloseCode, MAX_PLAINTEXT_FRAME_BYTES } from '../relay/e2ee.js';
import { createEncryptedSession } from '../relay/encrypted-session.js';
import { DIRECT_E2EE_TRANSPORT_HEADER } from '../opencode/tunnel-auth.js';

export const DIRECT_E2EE_PATH = '/api/openchamber/direct-e2ee/ws';

// Conservative production values. Four short-lived reserve slots remain
// available when the normal pre-auth pool is full. Reserve sessions may perform
// encrypted health and bearer session confirmation only, and get two seconds;
// pairing and Ping traffic cannot hold reconnect capacity.
const DIRECT_E2EE_LIMITS = Object.freeze({
  maxPending: 16,
  maxPreauthenticated: 16,
  reconnectReserve: 4,
  maxAuthenticated: 64,
  identityDeadlineMs: 10_000,
  identityRetryCooldownMs: 1_000,
  handshakeTimeoutMs: 15_000,
  authenticationDeadlineMs: 20_000,
  reconnectDeadlineMs: 2_000,
  idleTimeoutMs: 90_000,
  maxHandshakeMessages: 2,
  maxHandshakeBytes: 8 * 1024,
  maxStreams: 24,
  maxWebSockets: 4,
  maxIncompleteFragments: 8,
  maxPreauthFragmentBytes: 256 * 1024,
  maxAuthenticatedFragmentBytes: 16 * 1024 * 1024,
  maxPendingPerSource: 4,
  maxPreauthenticatedPerSource: 4,
  maxReservedPerSource: 1,
  maxStreamOpens: 40,
  streamOpenWindowMs: 10_000,
});

const rejectUpgrade = (socket, status, reason) => {
  if (!socket.destroyed) {
    const response = `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
    socket.write(response, () => socket.end());
  }
  return reason;
};

const rawHostHeader = (req) => {
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === 'host') values.push(req.rawHeaders[index + 1]);
  }
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
};

const hasValidOriginHeaders = (req) => {
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === 'origin') values.push(req.rawHeaders[index + 1]);
  }
  return values.length <= 1 && values.every((value) => typeof value === 'string' && !/[\0-\x1f\x7f]/.test(value));
};

const targetsDirectEndpoint = (rawTarget) => {
  if (typeof rawTarget !== 'string') return false;
  if (rawTarget.startsWith(DIRECT_E2EE_PATH)) return true;
  try {
    const parsed = new URL(rawTarget, 'http://direct.invalid');
    if (parsed.pathname === DIRECT_E2EE_PATH) return true;
    const decoded = decodeURIComponent(parsed.pathname);
    return new URL(decoded, 'http://direct.invalid').pathname === DIRECT_E2EE_PATH;
  } catch {
    return false;
  }
};

const canonicalProfileHostname = (value) => {
  if (typeof value !== 'string' || value !== value.trim() || value.endsWith('.') || value.includes(':')) return null;
  const lower = value.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(lower) || domainToASCII(lower) !== lower) return null;
  if (lower === 'localhost' || lower.split('.').length < 2) return null;
  return lower;
};

const validAuthority = (req, expectedHostname) => {
  const raw = rawHostHeader(req);
  if (!raw || raw !== raw.trim() || /[^\x21-\x7e]/.test(raw)) return false;
  let parsed;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  if (parsed.hostname !== expectedHostname || (parsed.port && parsed.port !== '443')) return false;
  return raw.toLowerCase() === expectedHostname || raw.toLowerCase() === `${expectedHostname}:443`;
};

const bearerToken = (headers) => {
  const value = headers?.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1] || null;
};

/** Owns the production direct-E2EE outer WebSocket endpoint. */
export const createDirectE2eeService = ({
  getActiveProfile,
  getRelayIdentity,
  getLocalPort,
  internalTransportMarker,
  authenticateBearerToken,
  logger = console,
  onInnerStreamClosed,
  limits: overrides = {},
  batchWindowMs = 0,
}) => {
  if (!internalTransportMarker) throw new Error('direct E2EE requires an internal transport marker');
  const limits = { ...DIRECT_E2EE_LIMITS, ...overrides };
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PLAINTEXT_FRAME_BYTES + 64 });
  const sessions = new Map();
  const byClient = new Map();
  let server = null;
  let detached = false;
  let cachedIdentity = null;
  let identityAttempt = null;
  let identityRetryAfter = 0;

  const counts = () => {
    const result = { pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: sessions.size };
    for (const entry of sessions.values()) {
      if (entry.state === 'pending') result.pending += 1;
      else if (entry.state === 'authenticated') result.authenticated += 1;
      else {
        result.preauthenticated += 1;
        if (entry.reserved) result.reserved += 1;
      }
    }
    return result;
  };

  const logReason = (reason, connectionId) => logger.warn?.('[DirectE2EE]', { reason, connectionId });

  const sourceKey = (req) => {
    const remote = req.socket?.remoteAddress;
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const cf = req.headers?.['cf-connecting-ip'];
    if (loopback && typeof cf === 'string' && net.isIP(cf.trim())) return cf.trim();
    return net.isIP(remote) ? remote : 'unknown';
  };

  const closeEntry = (entry, reason, code = 1008) => {
    if (!entry || entry.released) return;
    entry.released = true;
    entry.identityAttempt?.waiters.delete(entry);
    entry.identityAttempt = null;
    entry.pendingFrames.length = 0;
    entry.socket.off?.('message', entry.onMessage);
    entry.socket.off?.('close', entry.onClose);
    entry.socket.off?.('error', entry.onError);
    sessions.delete(entry.id);
    clearTimeout(entry.handshakeTimer);
    clearTimeout(entry.authTimer);
    clearInterval(entry.idleTimer);
    try {
      entry.encrypted?.close();
    } catch {
      // Continue releasing every owned resource and session.
    }
    entry.authChecks.clear();
    entry.pairingChecks.clear();
    entry.requestPurposes.clear();
    if (entry.clientId) {
      const set = byClient.get(entry.clientId);
      set?.delete(entry);
      if (set?.size === 0) byClient.delete(entry.clientId);
    }
    if (reason) logReason(reason, entry.id);
    try {
      if (entry.socket.readyState === WebSocket.OPEN) entry.socket.close(code, 'direct session closed');
      else if (entry.socket.readyState === WebSocket.CONNECTING) entry.socket.terminate();
    } catch {
      // Best-effort close; accounting is already released exactly once.
    }
  };

  const bindClient = (entry, clientId) => {
    if (typeof clientId !== 'string' || !clientId) return;
    entry.clientId = clientId;
    const set = byClient.get(clientId) ?? new Set();
    set.add(entry);
    byClient.set(clientId, set);
  };

  const promote = (entry, clientId) => {
    if (entry.state !== 'preauthenticated') return;
    if (counts().authenticated >= limits.maxAuthenticated) {
      closeEntry(entry, 'authenticated-capacity');
      return;
    }
    entry.state = 'authenticated';
    entry.reserved = false;
    clearTimeout(entry.authTimer);
    bindClient(entry, clientId);
  };

  const requestPolicy = (entry) => async (request) => {
    if (entry.state === 'pending') return 'Handshake is not established';
    const method = request.method?.toUpperCase();
    if (entry.state === 'preauthenticated') {
      if (request.kind !== 'http') return 'Authentication required';
      if (method === 'GET' && request.path === '/health' && !request.query) {
        entry.requestPurposes.set(request.generation, 'health');
        return true;
      }
      if (!entry.reserved && method === 'POST' && request.path === '/api/client-auth/pairing/redeem' && !request.query) {
        entry.pairingChecks.add(request.generation);
        entry.requestPurposes.set(request.generation, 'pairing');
        return true;
      }
      if (method === 'GET' && request.path === '/auth/session' && !request.query) {
        const token = bearerToken(request.headers);
        if (!token) {
          logReason('preauth-auth-rejected', entry.id);
          return 'Bearer authentication required';
        }
        const auth = await authenticateBearerToken(token);
        if (!auth?.ok) {
          logReason('preauth-auth-rejected', entry.id);
          entry.requestPurposes.set(request.generation, 'auth');
          return true;
        }
        if (entry.reserved && !entry.healthSeen) return 'Health confirmation required';
        entry.authChecks.set(request.generation, auth.client?.id || auth.clientId || null);
        entry.requestPurposes.set(request.generation, 'auth');
        return true;
      }
      logReason('preauth-route-rejected', entry.id);
      return 'Authentication required';
    }
    const authenticatedAuthRequestAllowed = !request.query && (
      (method === 'GET' && request.path === '/auth/session')
      || (method === 'POST' && request.path === '/auth/url-token')
      || (method === 'GET' && request.path === '/auth/passkey/status')
    );
    if (authenticatedAuthRequestAllowed) return true;
    const normalizedPath = request.path.toLowerCase();
    if (normalizedPath === '/auth' || normalizedPath.startsWith('/auth/')) return 'Browser authentication is unavailable';
    return true;
  };

  const establish = (entry) => {
    if (entry.state !== 'pending') return;
    clearTimeout(entry.handshakeTimer);
    const sameSourceOrdinary = [...sessions.values()].filter((candidate) => candidate !== entry && candidate.state === 'preauthenticated' && !candidate.reserved && candidate.source === entry.source);
    const sameSourceReserved = [...sessions.values()].filter((candidate) => candidate !== entry && candidate.state === 'preauthenticated' && candidate.reserved && candidate.source === entry.source);
    if (sameSourceOrdinary.length >= limits.maxPreauthenticatedPerSource) {
      closeEntry(sameSourceOrdinary.sort((a, b) => a.createdAt - b.createdAt)[0], 'source-preauth-evicted', 1008);
    }
    const afterSourceEviction = counts();
    if (afterSourceEviction.preauthenticated - afterSourceEviction.reserved < limits.maxPreauthenticated) {
      entry.reserved = false;
    } else {
      if (sameSourceReserved.length >= limits.maxReservedPerSource) {
        closeEntry(sameSourceReserved.sort((a, b) => a.createdAt - b.createdAt)[0], 'source-reserve-evicted', 1008);
      } else if (afterSourceEviction.reserved >= limits.reconnectReserve) {
        const oldestReserve = [...sessions.values()].filter((candidate) => candidate !== entry && candidate.state === 'preauthenticated' && candidate.reserved).sort((a, b) => a.createdAt - b.createdAt)[0];
        closeEntry(oldestReserve, 'reserve-probation-evicted', 1008);
      }
      entry.reserved = true;
    }
    entry.state = 'preauthenticated';
    entry.authTimer = setTimeout(() => closeEntry(entry, 'authentication-deadline', 1008), entry.reserved ? limits.reconnectDeadlineMs : limits.authenticationDeadlineMs);
    entry.authTimer.unref?.();
  };

  const initializeEncryptedEntry = (entry, identity) => {
    if (entry.released) return;
    entry.identityAttempt?.waiters.delete(entry);
    entry.identityAttempt = null;
    try {
      entry.encrypted = createEncryptedSession({
        socket: entry.socket,
        connectionId: entry.id,
        hostEncPrivateKey: identity.hostEncPrivateKey,
        getLocalPort,
        isActive: () => sessions.get(entry.id) === entry && !entry.released,
        onActivity: () => { entry.lastActivityAt = Date.now(); },
        onEstablished: () => establish(entry),
        onFailure: (code) => closeEntry(entry, 'channel-failure', code),
        logger: { warn: () => logReason('encrypted-session-failure', entry.id) },
        failOnIgnoredHandshake: true,
        batchWindowMs,
        tunnelOptions: {
          transportContext: {
            metadataHeader: null,
            stripOrigin: true,
            requestHeaders: { [DIRECT_E2EE_TRANSPORT_HEADER]: internalTransportMarker },
            wsHeaders: { [DIRECT_E2EE_TRANSPORT_HEADER]: internalTransportMarker },
          },
          requestPolicy: requestPolicy(entry),
          onResponse: ({ generation, status }) => {
            const purpose = entry.requestPurposes.get(generation);
            entry.requestPurposes.delete(generation);
            if (entry.reserved && purpose === 'health' && status === 200 && entry.state === 'preauthenticated') entry.healthSeen = true;
            if (entry.pairingChecks.delete(generation) && status >= 400) logReason('pairing-rejected', entry.id);
            const clientId = entry.authChecks.get(generation);
            entry.authChecks.delete(generation);
            if (status === 200 && clientId) promote(entry, clientId);
          },
          onLimitExceeded: (reason) => closeEntry(entry, reason, RelayCloseCode.ChannelFailure),
          onStreamClosed: (event) => {
            entry.authChecks.delete(event.generation);
            entry.pairingChecks.delete(event.generation);
            entry.requestPurposes.delete(event.generation);
            onInnerStreamClosed?.(event);
          },
          limits: {
            maxStreams: limits.maxStreams,
            maxWebSockets: limits.maxWebSockets,
            maxIncompleteFragments: limits.maxIncompleteFragments,
            getMaxIncompleteFragmentBytes: () => entry.state === 'authenticated' ? limits.maxAuthenticatedFragmentBytes : limits.maxPreauthFragmentBytes,
            maxStreamOpens: limits.maxStreamOpens,
            streamOpenWindowMs: limits.streamOpenWindowMs,
          },
          failClosedPolicy: true,
        },
      });
      for (const [data, isBinary] of entry.pendingFrames.splice(0)) entry.encrypted.receive(data, isBinary);
    } catch {
      closeEntry(entry, 'identity-unavailable', 1011);
      logReason('identity-unavailable', 'upgrade');
    }
  };

  const closeIdentityWaiters = (attempt, reason) => {
    const waiters = [...attempt.waiters];
    attempt.waiters.clear();
    for (const entry of waiters) {
      closeEntry(entry, reason, 1011);
      logReason(reason, 'upgrade');
    }
  };

  const settleIdentitySuccess = (attempt, identity) => {
    if (!identity?.hostEncPrivateKey) {
      settleIdentityRejection(attempt);
      return;
    }
    clearTimeout(attempt.deadlineTimer);
    attempt.deadlineTimer = null;
    cachedIdentity = identity;
    if (identityAttempt === attempt) identityAttempt = null;
    const waiters = [...attempt.waiters];
    attempt.waiters.clear();
    for (const entry of waiters) initializeEncryptedEntry(entry, identity);
  };

  const settleIdentityRejection = (attempt) => {
    clearTimeout(attempt.deadlineTimer);
    attempt.deadlineTimer = null;
    closeIdentityWaiters(attempt, 'identity-unavailable');
    if (identityAttempt === attempt) identityAttempt = null;
    identityRetryAfter = Date.now() + limits.identityRetryCooldownMs;
  };

  const startIdentityAttempt = (attempt) => {
    attempt.deadlineTimer = setTimeout(() => {
      if (identityAttempt !== attempt || attempt.state !== 'pending') return;
      attempt.state = 'timed-out';
      attempt.deadlineTimer = null;
      closeIdentityWaiters(attempt, 'identity-timeout');
    }, limits.identityDeadlineMs);
    attempt.deadlineTimer.unref?.();

    let pendingIdentity;
    try {
      pendingIdentity = getRelayIdentity();
    } catch {
      settleIdentityRejection(attempt);
      return;
    }
    Promise.resolve(pendingIdentity).then(
      (identity) => settleIdentitySuccess(attempt, identity),
      () => settleIdentityRejection(attempt),
    );
  };

  const waitForIdentity = (entry) => {
    if (cachedIdentity) {
      initializeEncryptedEntry(entry, cachedIdentity);
      return;
    }
    if (identityAttempt?.state === 'timed-out') {
      closeEntry(entry, 'identity-timeout', 1011);
      return;
    }
    if (Date.now() < identityRetryAfter) {
      closeEntry(entry, 'identity-cooldown', 1011);
      return;
    }

    let attempt = identityAttempt;
    if (!attempt) {
      attempt = { state: 'pending', waiters: new Set(), deadlineTimer: null, started: false };
      identityAttempt = attempt;
    }
    if (attempt.waiters.size >= limits.maxPending) {
      closeEntry(entry, 'identity-capacity', 1011);
      return;
    }
    attempt.waiters.add(entry);
    entry.identityAttempt = attempt;
    if (!attempt.started) {
      attempt.started = true;
      startIdentityAttempt(attempt);
    }
  };

  const acceptConnection = (socket, profile) => {
    const id = crypto.randomUUID();
    const entry = {
      id, socket, profileId: profile.id, state: 'pending', reserved: false, released: false,
      clientId: null, encrypted: null, handshakeMessages: 0, authChecks: new Map(), pairingChecks: new Set(), requestPurposes: new Map(), healthSeen: false, source: profile.source, createdAt: Date.now(), lastActivityAt: Date.now(),
      handshakeTimer: null, authTimer: null, idleTimer: null, pendingFrames: [], identityAttempt: null,
      onMessage: null, onClose: null, onError: null,
    };
    sessions.set(id, entry);
    entry.handshakeTimer = setTimeout(() => closeEntry(entry, 'handshake-timeout', 1008), limits.handshakeTimeoutMs);
    entry.handshakeTimer.unref?.();
    entry.idleTimer = setInterval(() => {
      if (Date.now() - entry.lastActivityAt > limits.idleTimeoutMs) closeEntry(entry, 'idle-timeout', 1001);
    }, Math.min(30_000, limits.idleTimeoutMs));
    entry.idleTimer.unref?.();
    entry.onMessage = (data, isBinary) => {
      if (entry.released) return;
      if (entry.state === 'pending') {
        entry.handshakeMessages += 1;
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
        if (entry.handshakeMessages > limits.maxHandshakeMessages || size > limits.maxHandshakeBytes) {
          closeEntry(entry, 'handshake-limit', 1008);
          return;
        }
      }
      if (!entry.encrypted) {
        entry.pendingFrames.push([data, isBinary]);
        return;
      }
      entry.encrypted.receive(data, isBinary);
    };
    entry.onClose = () => closeEntry(entry, 'disconnect', 1000);
    entry.onError = () => closeEntry(entry, 'socket-error', 1011);
    socket.on('message', entry.onMessage);
    socket.once('close', entry.onClose);
    socket.once('error', entry.onError);
    waitForIdentity(entry);
  };

  const upgradeHandler = (req, socket, head) => {
    const rawTarget = req.url;
    if (rawTarget !== DIRECT_E2EE_PATH) {
      if (targetsDirectEndpoint(rawTarget)) logReason(rejectUpgrade(socket, '400 Bad Request', 'target-rejected'), 'upgrade');
      return;
    }
    if (!hasValidOriginHeaders(req)) {
      logReason(rejectUpgrade(socket, '400 Bad Request', 'origin-malformed'), 'upgrade');
      return;
    }
    const profile = getActiveProfile();
    const hostname = canonicalProfileHostname(profile?.hostname);
    if (!profile || profile.mode !== 'managed-remote' || profile.directE2eeEnabled !== true || !profile.id || !hostname) {
      logReason(rejectUpgrade(socket, '404 Not Found', 'profile-inactive'), 'upgrade');
      return;
    }
    if (!validAuthority(req, hostname)) {
      logReason(rejectUpgrade(socket, '421 Misdirected Request', 'authority-rejected'), 'upgrade');
      return;
    }
    const source = sourceKey(req);
    const sourcePending = [...sessions.values()].filter((entry) => entry.state === 'pending' && entry.source === source);
    if (sourcePending.length >= limits.maxPendingPerSource) {
      closeEntry(sourcePending.sort((a, b) => a.createdAt - b.createdAt)[0], 'source-probation-evicted', 1008);
    }
    if (counts().pending >= limits.maxPending) {
      const oldest = [...sessions.values()].filter((entry) => entry.state === 'pending').sort((a, b) => a.createdAt - b.createdAt)[0];
      closeEntry(oldest, 'probation-evicted', 1008);
    }
    if (counts().total >= limits.maxPending + limits.maxPreauthenticated + limits.reconnectReserve + limits.maxAuthenticated) {
      logReason(rejectUpgrade(socket, '503 Service Unavailable', 'admission-capacity'), 'upgrade');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      acceptConnection(ws, { ...profile, source });
    });
  };

  return {
    attach(httpServer) {
      if (server) throw new Error('direct E2EE service is already attached');
      detached = false;
      server = httpServer;
      server.on('upgrade', upgradeHandler);
      return () => this.detach();
    },
    detach() {
      if (!server || detached) return;
      detached = true;
      server.off('upgrade', upgradeHandler);
      server = null;
      for (const entry of [...sessions.values()]) closeEntry(entry, 'service-detached', 1001);
      for (const socket of wss.clients) socket.terminate();
    },
    closeProfile(profileId, reason = 'profile-disabled') {
      for (const entry of [...sessions.values()]) if (entry.profileId === profileId) closeEntry(entry, reason, 1001);
    },
    closeAll(reason = 'tunnel-stopped') {
      for (const entry of [...sessions.values()]) closeEntry(entry, reason, 1001);
    },
    revokeClient(clientId) {
      for (const entry of [...(byClient.get(clientId) ?? [])]) closeEntry(entry, 'client-revoked', 1008);
    },
    getActiveSessionCount(profileId) {
      let count = 0;
      for (const entry of sessions.values()) if (!profileId || entry.profileId === profileId) count += 1;
      return count;
    },
    getCounts: counts,
    _getPendingFrameCount: () => [...sessions.values()]
      .reduce((total, entry) => total + entry.pendingFrames.length, 0),
    _webSocketServer: wss,
  };
};
