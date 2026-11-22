import { WebSocket, WebSocketServer } from 'ws';

import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const PERSISTENT_PTY_CONNECT_PATH = /^\/api\/experimental\/persistent-pty\/([A-Za-z0-9_-]+)\/connect$/;

/** A handshake that has not completed by now is not going to (realtime-proxy precedent, #962). */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Bytes one client may queue while its upstream is still connecting (realtime-proxy's pre-open cap). */
const MAX_PENDING_BYTES = 256 * 1024;
/** A peer further behind than this after connect is closed as too slow (realtime-proxy precedent). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

const FORWARDED_QUERY_KEYS = new Set([
  'cursor',
  'role',
  'attachment_id',
  'takeover',
  'input_protocol',
  'location[directory]',
]);

const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);

/**
 * Largest single WebSocket frame the persistent-pty proxy accepts from a
 * client. ws assembles a whole message before 'message' fires, so without
 * an explicit maxPayload one frame up to the ws default of 100 MiB was
 * assembled and forwarded whole (#1109). Sized at the terminal sibling
 * precedent (64 KiB) for terminal input. Under Node the ws layer refuses
 * an oversized frame (close 1009) before assembly; under Bun the bundled
 * ws does not enforce maxPayload, so the message handler below ALSO checks
 * the assembled size and drops the pair before the frame is forwarded or
 * queued (dev-tunnel #1082 precedent).
 */
export const PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Largest single WebSocket frame the persistent-pty proxy accepts from
 * its upstream (#1249). The upstream direction carries terminal OUTPUT,
 * which legitimately exceeds the client-direction cap above — one output
 * frame holds whatever a program flushed, not one keystroke — so this
 * bound is larger (16x), while staying far below the 100 MiB ws default
 * that applied before. Under Node the ws layer refuses an oversized
 * frame (close 1009) before assembly; under Bun the bundled ws does not
 * enforce maxPayload, so the upstream message handler ALSO checks the
 * assembled size and drops the pair before the frame is forwarded
 * (dev-tunnel #1082 precedent). Either way no oversized upstream frame
 * is ever forwarded.
 */
export const PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

const parsePathname = (rawUrl) => {
  try {
    return new URL(rawUrl || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
};

const buildUpstreamUrl = (buildOpenCodeUrl, requestUrl) => {
  const pathname = parsePathname(requestUrl);
  const incoming = new URL(requestUrl, 'http://127.0.0.1').searchParams;
  const upstream = new URL(buildOpenCodeUrl(pathname, ''));
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of incoming) {
    if (FORWARDED_QUERY_KEYS.has(key)) upstream.searchParams.append(key, value);
  }
  return upstream;
};

const safeCloseCode = (code) => (UNSENDABLE_CLOSE_CODES.has(code) ? 1011 : code || 1000);

export function createPersistentPtyWsRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
}) {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES });

  wsServer.on('connection', (client, req) => {
    let upstream;
    try {
      upstream = new WebSocket(buildUpstreamUrl(buildOpenCodeUrl, req.url), {
        headers: getOpenCodeAuthHeaders(),
        origin: new URL(buildOpenCodeUrl('/', '')).origin,
        // A wedged upstream must fail the pair, not hold it open forever.
        handshakeTimeout: handshakeTimeoutMs,
        // Bound upstream frames at assembly (#1249); the message handler
        // below re-checks because maxPayload is not enforced everywhere.
        maxPayload: PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES,
      });
    } catch {
      client.close(1011, 'OpenCode service unavailable');
      return;
    }

    // The ws handshake timeout is not honoured on every runtime this
    // server runs on, so the bound is also kept here (the realtime proxy
    // keeps its own timer for the same reason): expiry kills the attempt
    // and fails the client instead of leaving its session open on a dead
    // upstream, and anything queued for it is dropped.
    const pending = [];
    let pendingBytes = 0;
    const handshakeTimer = setTimeout(() => {
      pending.length = 0;
      pendingBytes = 0;
      try { upstream.terminate(); } catch { /* already gone */ }
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(1011, 'Persistent PTY upstream handshake timed out'); } catch { /* already closing */ }
      }
    }, handshakeTimeoutMs);
    upstream.once('open', () => clearTimeout(handshakeTimer));
    upstream.once('error', () => clearTimeout(handshakeTimer));
    upstream.once('close', () => clearTimeout(handshakeTimer));
    client.once('close', () => clearTimeout(handshakeTimer));

    const closePair = (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(code, reason); } catch { /* already closing */ }
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.terminate(); } catch { /* already gone */ }
      }
    };

    // Forwarding ignores how far behind the receiving peer is falling;
    // past the bound the pair is closed instead of buffering without limit.
    const closeIfPeerTooSlow = (peer) => {
      if (peer.bufferedAmount <= maxBufferedBytes) return;
      closePair(1013, 'Persistent PTY peer is too slow');
    };

    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const [data, isBinary] = pending.shift();
        upstream.send(data, { binary: isBinary });
      }
      pendingBytes = 0;
      closeIfPeerTooSlow(upstream);
    };

    client.on('message', (data, isBinary) => {
      // Per-frame bound (#1109): see the constant above — refuse an
      // oversized frame here, before it is forwarded or queued, with the
      // same 1009 the ws layer would have used.
      if (data.length > PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES) {
        try { client.close(1009, 'Persistent PTY frame too large'); } catch { /* already closing */ }
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try { upstream.close(); } catch { /* already closing */ }
        }
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        closeIfPeerTooSlow(upstream);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pendingBytes += data.length;
        if (pendingBytes > maxPendingBytes) {
          // The handshake is stalled and the queue is full: drop the pair
          // rather than hold every byte until the upstream recovers, and
          // never flush what was queued.
          pending.length = 0;
          pendingBytes = 0;
          try { upstream.terminate(); } catch { /* already gone */ }
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            try { client.close(1013, 'Persistent PTY queue is full'); } catch { /* already closing */ }
          }
          return;
        }
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      // Per-frame bound (#1249): see the upstream constant above — refuse
      // an oversized frame here, before it is forwarded, with the same
      // 1009 the ws layer would have used.
      if (data.length > PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES) {
        try { client.close(1009, 'Persistent PTY upstream frame too large'); } catch { /* already closing */ }
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try { upstream.close(); } catch { /* already closing */ }
        }
        return;
      }
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
        closeIfPeerTooSlow(client);
      }
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(safeCloseCode(code), reason);
      }
    });
    upstream.on('error', (error) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        // Where the ws layer DOES enforce the upstream maxPayload (Node),
        // the refusal surfaces here as a RangeError instead of a 'message'
        // event; the pair still closes with the same 1009 (#1249).
        if (error instanceof RangeError && /max payload/i.test(error.message)) {
          client.close(1009, 'Persistent PTY upstream frame too large');
        } else {
          client.close(1011, 'OpenCode terminal upstream error');
        }
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
    client.on('error', () => {});
  });

  const handleUpgrade = async (req, socket, head) => {
    if (isOpaqueOriginRequest(req)) {
      rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      return;
    }
    if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
      rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      return;
    }
    if (uiAuthController?.enabled) {
      const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
      if (!sessionToken) {
        rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      if (!await isRequestOriginAllowed(req)) {
        rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        return;
      }
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req);
    });
  };

  const upgradeHandler = (req, socket, head) => {
    if (!PERSISTENT_PTY_CONNECT_PATH.test(parsePathname(req.url))) return;
    void handleUpgrade(req, socket, head).catch(() => {
      rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
    });
  };

  server.on('upgrade', upgradeHandler);

  return {
    close() {
      server.off('upgrade', upgradeHandler);
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
    },
  };
}
