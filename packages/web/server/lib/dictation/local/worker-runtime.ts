import { z } from 'zod';

import {
  SherpaOfflineRecognizerEngine,
  SherpaSegmentTranscriptionSession,
} from './sherpa-recognizer.js';
import { SherpaTtsEngine } from './sherpa-tts.js';
import type { SherpaTtsConfig } from './sherpa-tts.js';
import { getLocalSttModelDir, getLocalSttModelSpec } from './model-catalog.js';
import { resolveModelLanguage } from './model-language.js';
import { pcm16ToWav } from '../audio.js';
import { resolveEngineThreads } from './engine-threads.js';
import { WORKER_REQUEST_TYPES, requestHeadSchema, workerRequestSchema } from './worker-protocol.js';
import type { CommittedPayload, TranscriptPayload, WorkerRequest, WorkerResult } from './worker-protocol.js';

process.title = 'OpenChamber Dictation';

const ENGINE_THREADS = resolveEngineThreads();

const engines = new Map<string, SherpaOfflineRecognizerEngine>();
const ttsEngines = new Map<string, SherpaTtsEngine<string>>();
const sessions = new Map<string, SherpaSegmentTranscriptionSession>();
let ipcClosing = false;

type ParentMessage =
  | { type: 'response'; requestId: unknown; ok: boolean; result?: WorkerResult; error?: string }
  | { type: 'session.committed'; sessionId: string; payload: CommittedPayload }
  | { type: 'session.transcript'; sessionId: string; payload: TranscriptPayload }
  | { type: 'session.error'; sessionId: string; error: string };

function sendToParent(message: ParentMessage) {
  if (ipcClosing || !process.connected || !process.send) {
    return;
  }
  try {
    process.send(message, (error) => {
      if (error) {
        ipcClosing = true;
      }
    });
  } catch {
    ipcClosing = true;
  }
}

function sendOk(requestId: string, result?: WorkerResult) {
  const message: ParentMessage = { type: 'response', requestId, ok: true };
  if (result !== undefined) message.result = result;
  sendToParent(message);
}

function getEngine(modelsDir: string, modelId: string, language: string | undefined) {
  const spec = getLocalSttModelSpec(modelId);
  const modelKey = `${modelsDir}:${modelId}`;
  const key = `${modelKey}:${resolveModelLanguage(modelId, spec.type, language)}`;
  const existing = engines.get(key);
  if (existing) {
    return existing;
  }
  const inUse = new Set(Array.from(sessions.values(), (session) => session.engine));
  for (const [otherKey, engine] of engines) {
    if (otherKey.startsWith(`${modelKey}:`) && !inUse.has(engine)) {
      engine.free();
      engines.delete(otherKey);
    }
  }
  const created = new SherpaOfflineRecognizerEngine({
    modelId,
    type: spec.type,
    modelDir: getLocalSttModelDir(modelsDir, modelId),
    files: spec.files,
    language,
    numThreads: ENGINE_THREADS,
  });
  engines.set(key, created);
  return created;
}

function cleanupSession(sessionId: string) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  try {
    session?.close();
  } catch {
    return;
  }
}

const serializedBufferSchema = z.object({ type: z.literal('Buffer'), data: z.array(z.number()) });

function toBuffer<Audio>(audio: Audio) {
  if (Buffer.isBuffer(audio)) {
    return audio;
  }
  if (audio instanceof Uint8Array) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  const serialized = serializedBufferSchema.safeParse(audio);
  if (serialized.success) {
    return Buffer.from(serialized.data.data);
  }
  throw new Error('Unsupported audio payload in dictation worker');
}

function parseRequest<Message>(message: Message): WorkerRequest {
  const parsed = workerRequestSchema.safeParse(message);
  if (parsed.success) {
    return parsed.data;
  }
  const { type } = requestHeadSchema.parse(message);
  if (!WORKER_REQUEST_TYPES.some((known) => known === type)) {
    throw new Error(`Unknown dictation worker request: ${type}`);
  }
  throw new Error(`Malformed dictation worker request: ${type}`);
}

function ttsConfigOf(modelsDir: string, modelId: string): SherpaTtsConfig<string> {
  const spec = getLocalSttModelSpec(modelId);
  const modelDir = getLocalSttModelDir(modelsDir, modelId);
  const { model, tokens, espeakData, voices } = spec.files;
  if (model === undefined || tokens === undefined) {
    throw new Error(`Local TTS model ${modelId} names no model or tokens file`);
  }
  if (spec.type === 'vits') {
    return { type: 'vits', modelDir, files: { ...spec.files, model, tokens }, numThreads: ENGINE_THREADS };
  }
  if (spec.type === 'kokoro') {
    if (espeakData === undefined || voices === undefined) {
      throw new Error(`Local TTS model ${modelId} names no espeak data or voices file`);
    }
    return { type: 'kokoro', modelDir, files: { ...spec.files, model, tokens, espeakData, voices }, lexicon: spec.lexicon, numThreads: ENGINE_THREADS };
  }
  throw new Error(`Unsupported local TTS model type: ${spec.type}`);
}

function getTtsEngine(modelsDir: string, modelId: string) {
  const key = `${modelsDir}:${modelId}`;
  const existing = ttsEngines.get(key);
  if (existing) {
    return existing;
  }
  const created = new SherpaTtsEngine(ttsConfigOf(modelsDir, modelId));
  ttsEngines.set(key, created);
  return created;
}

async function handleRequest<Raw>(raw: Raw) {
  const message = parseRequest(raw);
  switch (message.type) {
    case 'tts.synthesize': {
      const engine = getTtsEngine(message.modelsDir, message.modelId);
      const { pcm16, sampleRate } = engine.synthesize(message.text, {
        speakerId: message.speakerId,
        speed: message.speed,
      });
      sendOk(message.requestId, {
        audio: pcm16ToWav(pcm16, sampleRate),
        format: 'audio/wav',
      });
      return;
    }
    case 'session.create': {
      cleanupSession(message.sessionId);
      const engine = getEngine(message.modelsDir, message.modelId, message.language);
      const session = new SherpaSegmentTranscriptionSession({ engine });
      session.on('committed', (payload: CommittedPayload) => {
        sendToParent({ type: 'session.committed', sessionId: message.sessionId, payload });
      });
      session.on('transcript', (payload: TranscriptPayload) => {
        sendToParent({ type: 'session.transcript', sessionId: message.sessionId, payload });
      });
      session.on('error', (err: Error) => {
        sendToParent({
          type: 'session.error',
          sessionId: message.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await session.connect();
      sessions.set(message.sessionId, session);
      sendOk(message.requestId, { requiredSampleRate: session.requiredSampleRate });
      return;
    }
    case 'session.append': {
      const audio = toBuffer(message.audio);
      sessions.get(message.sessionId)?.appendPcm16(audio);
      sendOk(message.requestId);
      return;
    }
    case 'session.commit': {
      const session = sessions.get(message.sessionId);
      if (!session) {
        sendOk(message.requestId);
        return;
      }
      const pending = session.takePendingSegment();
      sendOk(message.requestId);
      if (pending) {
        setImmediate(() => {
          try {
            session.decodeSegment(pending);
          } catch (err) {
            sendToParent({
              type: 'session.error',
              sessionId: message.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
      return;
    }
    case 'session.clear': {
      sessions.get(message.sessionId)?.clear();
      sendOk(message.requestId);
      return;
    }
    case 'session.close': {
      cleanupSession(message.sessionId);
      sendOk(message.requestId);
      return;
    }
  }
}

process.on('message', (message) => {
  void handleRequest(message).catch((error) => {
    sendToParent({
      type: 'response',
      requestId: requestHeadSchema.parse(message).requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Dictation worker request failed',
    });
  });
});

process.once('disconnect', () => {
  ipcClosing = true;
  for (const sessionId of Array.from(sessions.keys())) {
    cleanupSession(sessionId);
  }
  for (const engine of engines.values()) {
    engine.free();
  }
  for (const tts of ttsEngines.values()) {
    tts.free();
  }
  process.exit(0);
});
