/**
 * Dictation runtime: registers the streaming dictation WebSocket endpoint and
 * the HTTP status/model routes.
 *
 * WebSocket protocol (JSON text frames) on /api/dictation/ws:
 *   client -> server:
 *     { type: 'start',  dictationId, format, options? }
 *       options: { provider?, language?, localModel?, openaiCompatible?, correct? }
 *       correct: fix misheard words with the Small Model before `final`
 *       Sending `start` again with an id the server still holds resumes that
 *       stream: the server answers with `ack` carrying its last acked seq and
 *       the client continues from the next one. Nothing is decoded twice.
 *     { type: 'chunk',  dictationId, seq, audio }   // audio: base64 PCM16LE
 *     { type: 'finish', dictationId, finalSeq }
 *     { type: 'cancel', dictationId }
 *     { type: 'ping' }
 *   server -> client:
 *     { type: 'ready' }
 *     { type: 'ack',             dictationId, ackSeq }
 *     { type: 'partial',         dictationId, text }
 *     { type: 'finish_accepted', dictationId, timeoutMs }
 *     { type: 'final',           dictationId, text }
 *     { type: 'error',           dictationId, error, retryable, reasonCode? }
 *     { type: 'pong' }
 */

import { WebSocketServer } from 'ws';

import { DictationStreamManager } from './stream-manager.js';
import { createDictationService } from './service.js';
import { createTranscriptCorrector } from './transcript-correction.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const DICTATION_WS_PATH = '/api/dictation/ws';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
const DICTATION_WS_HEARTBEAT_INTERVAL_MS = 30000;
// A dictation whose socket dropped is kept this long so the client can come
// back and resume it. The client retries for 15s, so this leaves headroom
// without holding a transcription session forever when a tab was closed.
const DICTATION_RESUME_GRACE_MS = 30000;
// A finished dictation keeps its text this long, so a client whose socket died
// between `finish` and `final` gets the text when it comes back. Without it,
// its repeated `start` would create a fresh stream with no audio and the
// dictation would be lost although the server had already transcribed it.
const DICTATION_FINAL_CACHE_TTL_MS = 30000;

const parseRequestPathname = (url) => {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return typeof url === 'string' ? url.split('?')[0] : '';
  }
};

export function createDictationRuntime({
  app,
  server,
  express,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  modelsDir,
  // A caller that brings its own service (tests) skips the model plumbing.
  service: providedService,
}) {
  const service = providedService ?? createDictationService({ modelsDir });
  const correctTranscript = createTranscriptCorrector({
    generate: async (args) => (await import('../small-model/index.js')).generateSmallModelText(args),
  });

  // Local text-to-speech (Kokoro in the dictation worker). Returns WAV bytes;
  // 503 with a reason code while the model is still downloading.
  app.post('/api/dictation/tts/speak', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }
      const result = await service.synthesizeSpeech({
        text,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        speakerId: Number.isInteger(req.body?.speakerId) ? req.body.speakerId : undefined,
        speed: typeof req.body?.speed === 'number' ? req.body.speed : undefined,
        language: req.body?.language === 'auto' ? 'auto' : undefined,
        languageSample: typeof req.body?.languageSample === 'string' ? req.body.languageSample.slice(0, 4000) : undefined,
      });
      if (result.error) {
        res.status(503).json({
          error: result.error,
          retryable: result.retryable !== false,
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        });
        return;
      }
      res.setHeader('Content-Type', result.format || 'audio/wav');
      res.setHeader('X-Speech-Model', result.modelId);
      if (result.language) res.setHeader('X-Speech-Language', result.language);
      res.send(result.audio);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to synthesize speech' });
    }
  });

  app.get('/api/dictation/status', async (req, res) => {
    try {
      const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
      const localModel = typeof req.query.localModel === 'string' ? req.query.localModel : undefined;
      const status = await service.getStatus({ provider, localModel });
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to read dictation status' });
    }
  });

  app.post('/api/dictation/models/:modelId/download', async (req, res) => {
    try {
      const result = await service.requestModelDownload(req.params.modelId);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to start model download' });
    }
  });

  app.delete('/api/dictation/models/:modelId', async (req, res) => {
    try {
      const result = await service.deleteModel(req.params.modelId);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to delete model' });
    }
  });

  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: DICTATION_WS_MAX_PAYLOAD_BYTES,
  });

  const sendToSocket = (socket, msg) => {
    if (socket.readyState !== 1) {
      return;
    }
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // socket is going away; the manager cleanup on close handles state
    }
  };

  // One manager per runtime, not one per socket. A dictation interrupted by a
  // dropped connection has to outlive that socket: the client reconnects and
  // sends `start` with the dictation id it already had, and the manager
  // answers with its last ack so only the missing audio is replayed. A stream
  // whose socket never comes back is cleaned up after the grace period.
  const socketByDictationId = new Map();
  const detachTimers = new Map();

  // dictationId -> { text, at }: the last finished dictations, so a client
  // that missed its `final` gets the same text again instead of a fresh,
  // empty stream. Bounded by time, never by count.
  const finalCache = new Map();
  const finalCacheTimers = new Map();

  const clearDetachTimer = (dictationId) => {
    const timer = detachTimers.get(dictationId);
    if (timer) {
      clearTimeout(timer);
      detachTimers.delete(dictationId);
    }
  };

  const forgetFinal = (dictationId) => {
    finalCache.delete(dictationId);
    const timer = finalCacheTimers.get(dictationId);
    if (timer) {
      clearTimeout(timer);
      finalCacheTimers.delete(dictationId);
    }
  };

  const rememberFinal = (dictationId, text) => {
    forgetFinal(dictationId);
    finalCache.set(dictationId, { text: typeof text === 'string' ? text : '', at: Date.now() });
    const timer = setTimeout(() => {
      finalCacheTimers.delete(dictationId);
      finalCache.delete(dictationId);
    }, DICTATION_FINAL_CACHE_TTL_MS);
    timer.unref?.();
    finalCacheTimers.set(dictationId, timer);
  };

  /** The cached text for an id, if it is still inside the TTL. */
  const cachedFinal = (dictationId) => {
    const entry = finalCache.get(dictationId);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.at > DICTATION_FINAL_CACHE_TTL_MS) {
      forgetFinal(dictationId);
      return null;
    }
    return entry.text;
  };

  const manager = new DictationStreamManager({
    emit: ({ type, payload }) => {
      const socket = socketByDictationId.get(payload.dictationId);
      if (socket) {
        sendToSocket(socket, { type, ...payload });
      }
      if (type === 'final') {
        // Keep the text for a client that lost the socket before this frame
        // arrived: its repeated `start` is answered from here.
        rememberFinal(payload.dictationId, payload.text);
        clearDetachTimer(payload.dictationId);
        socketByDictationId.delete(payload.dictationId);
      }
    },
    createSttSession: (options) => service.createSttSession(options),
    correctTranscript,
    // One diagnostic line per stream event, so a dictation that stops early
    // or finalizes slowly can be traced afterwards. It never carries the
    // transcript text, only lengths and counters.
    log: (line) => console.log(line),
  });

  const attachDictation = (dictationId, socket) => {
    clearDetachTimer(dictationId);
    socketByDictationId.set(dictationId, socket);
  };

  const detachSocket = (socket) => {
    for (const [dictationId, owner] of Array.from(socketByDictationId.entries())) {
      if (owner !== socket) {
        continue;
      }
      socketByDictationId.delete(dictationId);
      const timer = setTimeout(() => {
        detachTimers.delete(dictationId);
        manager.cleanupStream(dictationId, 'disconnect');
      }, DICTATION_RESUME_GRACE_MS);
      timer.unref?.();
      detachTimers.set(dictationId, timer);
    }
  };

  wsServer.on('connection', (socket) => {
    const send = (msg) => sendToSocket(socket, msg);

    send({ type: 'ready' });

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }, DICTATION_WS_HEARTBEAT_INTERVAL_MS);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') {
        return;
      }

      switch (message.type) {
        case 'start': {
          if (typeof message.dictationId !== 'string' || typeof message.format !== 'string') {
            return;
          }
          const options =
            message.options && typeof message.options === 'object' ? message.options : {};
          // The server was already done while this client's socket was away:
          // answer with the finished text instead of opening a stream that has
          // no audio left to decode.
          const finishedText = manager.streams.has(message.dictationId)
            ? null
            : cachedFinal(message.dictationId);
          if (finishedText !== null) {
            send({ type: 'final', dictationId: message.dictationId, text: finishedText });
            return;
          }
          attachDictation(message.dictationId, socket);
          void manager.handleStart(message.dictationId, message.format, options);
          return;
        }
        case 'chunk': {
          if (
            typeof message.dictationId !== 'string' ||
            typeof message.seq !== 'number' ||
            typeof message.audio !== 'string'
          ) {
            return;
          }
          manager.handleChunk({
            dictationId: message.dictationId,
            seq: message.seq,
            audioBase64: message.audio,
          });
          return;
        }
        case 'finish': {
          if (typeof message.dictationId !== 'string' || typeof message.finalSeq !== 'number') {
            return;
          }
          manager.handleFinish(message.dictationId, message.finalSeq);
          return;
        }
        case 'cancel': {
          if (typeof message.dictationId !== 'string') {
            return;
          }
          // A cancelled dictation keeps nothing for the resume window: no
          // cached text may answer a later `start` for this id, no detach
          // timer may resurrect the stream, and the id owns no socket.
          clearDetachTimer(message.dictationId);
          socketByDictationId.delete(message.dictationId);
          forgetFinal(message.dictationId);
          manager.handleCancel(message.dictationId);
          return;
        }
        case 'ping': {
          send({ type: 'pong' });
          return;
        }
        default:
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeatInterval);
      // Keep the dictation alive for a short grace period: the client
      // reconnects and resumes it, and only a stream nobody comes back for is
      // cleaned up.
      detachSocket(socket);
    });

    socket.on('error', () => {
      // 'close' follows and performs cleanup.
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== DICTATION_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (isOpaqueOriginRequest(req)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  const stop = () => {
    server.off('upgrade', upgradeHandler);
    for (const client of wsServer.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    try {
      wsServer.close();
    } catch {
      // ignore
    }
    // Nothing may outlive the runtime: open transcription sessions, the
    // timers that would clean them up later, and the finished texts.
    for (const timer of detachTimers.values()) {
      clearTimeout(timer);
    }
    detachTimers.clear();
    for (const dictationId of Array.from(finalCache.keys())) {
      forgetFinal(dictationId);
    }
    socketByDictationId.clear();
    manager.cleanupAll();
    service.shutdown();
  };

  return { stop };
}
