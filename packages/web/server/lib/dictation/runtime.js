/**
 * Dictation runtime: registers the streaming dictation WebSocket endpoint and
 * the HTTP status/model routes.
 *
 * WebSocket protocol (JSON text frames) on /api/dictation/ws:
 *   client -> server:
 *     { type: 'start',  dictationId, format, options? }
 *       options: { provider?, language?, localModel?, openaiCompatible? }
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

const DICTATION_WS_PATH = '/api/dictation/ws';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
const DICTATION_WS_HEARTBEAT_INTERVAL_MS = 30000;

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
}) {
  const service = createDictationService({ modelsDir });

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

  wsServer.on('connection', (socket) => {
    const send = (msg) => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        // socket is going away; the manager cleanup on close handles state
      }
    };

    const manager = new DictationStreamManager({
      emit: ({ type, payload }) => send({ type, ...payload }),
      createSttSession: (options) => service.createSttSession(options),
    });

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
      manager.cleanupAll();
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
    service.shutdown();
  };

  return { stop };
}
