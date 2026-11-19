
import { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Application, ExpressFactory } from '../shared/http-contracts.js';
import type { WebSocketServer as DictationWebSocketServer } from '../shared/websocket-contracts.js';
import type { RequestOriginChecker } from '../security/request-security.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

import { DictationStreamManager } from './stream-manager.js';
import { createDictationService } from './service.js';
import { createTranscriptCorrector } from './transcript-correction.js';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const DICTATION_WS_PATH = '/api/dictation/ws';

const DICTATION_WS_MAX_PAYLOAD_BYTES = 512 * 1024;
const DICTATION_WS_HEARTBEAT_INTERVAL_MS = 30000;

export interface DictationRuntimeDependencies {
  app: Application;
  server: Server;
  express: ExpressFactory;
  uiAuthController?: ReturnType<typeof createUiAuth> | null;
  isRequestOriginAllowed: RequestOriginChecker;
  rejectWebSocketUpgrade: (socket: Duplex, statusCode: number, reason: string) => void;
  modelsDir: string;
}

interface DictationWireMessage {
  type: string;
}

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
}: DictationRuntimeDependencies) {
  const service = createDictationService({ modelsDir });
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

  wsServer.on('connection', (socket) => {
    const send = (msg: DictationWireMessage) => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        return;
      }
    };

    const manager = new DictationStreamManager({
      emit: ({ type, payload }) => send({ type, ...payload }),
      createSttSession: (options) => service.createSttSession(options),
      correctTranscript,
    });

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
    service.shutdown();
  };

  return { stop };
}
