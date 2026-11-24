
import { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Application, ExpressFactory } from '../shared/http-contracts.js';
import type { WebSocket, WebSocketServer as DictationWebSocketServer } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

import { DictationStreamManager } from './stream-manager.js';
import { createDictationService } from './service.js';
import { createTranscriptCorrector } from './transcript-correction.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const DICTATION_WS_PATH = '/api/dictation/ws';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
const DICTATION_WS_HEARTBEAT_INTERVAL_MS = 30000;
const DICTATION_RESUME_GRACE_MS = 30000;
const DICTATION_FINAL_CACHE_TTL_MS = 30000;

export interface DictationRuntimeDependencies {
  app: Application;
  server: Server;
  express: ExpressFactory;
  uiAuthController?: ReturnType<typeof createUiAuth> | null;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: (socket: Duplex, statusCode: number, reason: string) => void;
  modelsDir: string;
  service?: ReturnType<typeof createDictationService>;
}

type DictationWireMessage = { type: 'ready' | 'pong' } | {
  type: string;
  dictationId: string;
  text?: string;
};

interface DictationReadinessError {
  error: string;
  retryable: boolean;
  reasonCode?: string;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function hasMessage(value: unknown): value is { message?: unknown } {
  return value !== null && value !== undefined;
}

function hasSpeechFields(value: unknown): value is {
  text?: unknown;
  model?: unknown;
  speakerId?: unknown;
  speed?: unknown;
  language?: unknown;
  languageSample?: unknown;
} {
  return value !== null && value !== undefined;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

type SpeechResult = Awaited<ReturnType<ReturnType<typeof createDictationService>['synthesizeSpeech']>>;

function hasSpeechError(result: SpeechResult): result is Extract<SpeechResult, { error: string }> {
  return Boolean(result.error);
}

function trackedClients(server: DictationWebSocketServer) {
  const clients = server.clients;
  if (clients === undefined) throw new TypeError('wsServer.clients is not iterable');
  return clients;
}

const parseRequestPathname = (url: string | undefined) => {
  try {
    return new URL(String(url), 'http://localhost').pathname;
  } catch {
    return url === undefined ? '' : url.split('?')[0];
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
  service: providedService,
}: DictationRuntimeDependencies) {
  const service = providedService ?? createDictationService({ modelsDir });
  const correctTranscript = createTranscriptCorrector({
    generate: async (args) => (await import('../small-model/index.js')).generateSmallModelText({
      ...args,
      directory: undefined,
      maxOutputTokens: undefined,
      model: undefined,
      preferredModelID: undefined,
      preferredProviderID: undefined,
      responseSchema: undefined,
      variant: undefined,
    }),
  });

  app.post('/api/dictation/tts/speak', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const body = hasSpeechFields(req.body) ? req.body : {};
      const text = isString(body.text) ? body.text.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }
      const result = await service.synthesizeSpeech({
        text,
        model: isString(body.model) ? body.model : undefined,
        speakerId: isInteger(body.speakerId) ? body.speakerId : undefined,
        speed: isNumber(body.speed) ? body.speed : undefined,
        language: body.language === 'auto' ? 'auto' : undefined,
        languageSample: isString(body.languageSample) ? body.languageSample.slice(0, 4000) : undefined,
      });
      if (hasSpeechError(result)) {
        const failure: DictationReadinessError = {
          error: result.error,
          retryable: result.retryable !== false,
        };
        if (result.reasonCode) failure.reasonCode = result.reasonCode;
        res.status(503).json(failure);
        return;
      }
      res.setHeader('Content-Type', result.format || 'audio/wav');
      res.setHeader('X-Speech-Model', result.modelId);
      if (result.language) res.setHeader('X-Speech-Language', result.language);
      res.send(result.audio);
    } catch (error) {
      res.status(500).json({ error: (hasMessage(error) && error.message) || 'Failed to synthesize speech' });
    }
  });

  app.get('/api/dictation/status', async (req, res) => {
    try {
      const provider = isString(req.query.provider) ? req.query.provider : undefined;
      const localModel = isString(req.query.localModel) ? req.query.localModel : undefined;
      const status = await service.getStatus({ provider, localModel });
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: (hasMessage(error) && error.message) || 'Failed to read dictation status' });
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
      res.status(500).json({ error: (hasMessage(error) && error.message) || 'Failed to start model download' });
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
      res.status(500).json({ error: (hasMessage(error) && error.message) || 'Failed to delete model' });
    }
  });

  const wsServer: DictationWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: DICTATION_WS_MAX_PAYLOAD_BYTES,
  });

  const sendToSocket = (socket: WebSocket, msg: DictationWireMessage) => {
    if (socket.readyState !== 1) {
      return;
    }
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      return;
    }
  };

  const socketByDictationId = new Map<string, WebSocket>();
  const detachTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const finalCache = new Map<string, { text: string; at: number }>();
  const finalCacheTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearDetachTimer = (dictationId: string) => {
    const timer = detachTimers.get(dictationId);
    if (timer) {
      clearTimeout(timer);
      detachTimers.delete(dictationId);
    }
  };

  const forgetFinal = (dictationId: string) => {
    finalCache.delete(dictationId);
    const timer = finalCacheTimers.get(dictationId);
    if (timer) {
      clearTimeout(timer);
      finalCacheTimers.delete(dictationId);
    }
  };

  const rememberFinal = (dictationId: string, text: string) => {
    forgetFinal(dictationId);
    finalCache.set(dictationId, { text, at: Date.now() });
    const timer = setTimeout(() => {
      finalCacheTimers.delete(dictationId);
      finalCache.delete(dictationId);
    }, DICTATION_FINAL_CACHE_TTL_MS);
    timer.unref?.();
    finalCacheTimers.set(dictationId, timer);
  };

  const cachedFinal = (dictationId: string) => {
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
    emit: (message) => {
      const { type, payload } = message;
      const socket = socketByDictationId.get(payload.dictationId);
      if (socket) {
        sendToSocket(socket, { type, ...payload });
      }
      if (type === 'final' && 'text' in payload) {
        rememberFinal(payload.dictationId, payload.text);
        clearDetachTimer(payload.dictationId);
        socketByDictationId.delete(payload.dictationId);
      }
    },
    createSttSession: (options) => service.createSttSession(options),
    correctTranscript,
  });

  const attachDictation = (dictationId: string, socket: WebSocket) => {
    clearDetachTimer(dictationId);
    socketByDictationId.set(dictationId, socket);
  };

  const detachSocket = (socket: WebSocket) => {
    for (const [dictationId, owner] of Array.from(socketByDictationId.entries())) {
      if (owner !== socket) {
        continue;
      }
      socketByDictationId.delete(dictationId);
      const timer = setTimeout(() => {
        detachTimers.delete(dictationId);
        manager.cleanupStream(dictationId);
      }, DICTATION_RESUME_GRACE_MS);
      timer.unref?.();
      detachTimers.set(dictationId, timer);
    }
  };

  wsServer.on('connection', (socket) => {
    const send = (msg: DictationWireMessage) => sendToSocket(socket, msg);

    send({ type: 'ready' });

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.ping();
      } catch {
        return;
      }
    }, DICTATION_WS_HEARTBEAT_INTERVAL_MS);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!isMessageObject(message)) {
        return;
      }

      switch (message.type) {
        case 'start': {
          if (!isString(message.dictationId) || !isString(message.format)) {
            return;
          }
          const options =
            isMessageObject(message.options) ? message.options : {};
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
            !isString(message.dictationId) ||
            !isNumber(message.seq) ||
            !isString(message.audio)
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
          if (!isString(message.dictationId) || !isNumber(message.finalSeq)) {
            return;
          }
          manager.handleFinish(message.dictationId, message.finalSeq);
          return;
        }
        case 'cancel': {
          if (!isString(message.dictationId)) {
            return;
          }
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
      detachSocket(socket);
    });

    socket.on('error', () => {
    });
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    for (const client of trackedClients(wsServer)) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        continue;
      }
    }
    try {
      wsServer.close();
    } catch {
      void 0;
    }
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
