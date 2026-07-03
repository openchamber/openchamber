/**
 * Dictation local-speech worker process.
 *
 * Hosts the sherpa-onnx native inference (Parakeet STT) in a separate process
 * so ONNX decoding never blocks the main OpenChamber server. Communicates
 * with the parent over child_process IPC (advanced serialization, so Buffers
 * survive the trip as Uint8Array).
 *
 * Request/response protocol (parent -> worker):
 *   { type: 'session.create', requestId, sessionId, modelsDir, modelId }
 *   { type: 'session.append', requestId, sessionId, audio }
 *   { type: 'session.commit' | 'session.clear' | 'session.close', requestId, sessionId }
 * Worker -> parent:
 *   { type: 'response', requestId, ok, result?, error? }
 *   { type: 'session.committed' | 'session.transcript' | 'session.error', sessionId, ... }
 */

import {
  SherpaOfflineRecognizerEngine,
  SherpaRealtimeTranscriptionSession,
} from './sherpa-recognizer.js';
import { getLocalSttModelDir } from './model-catalog.js';

process.title = 'OpenChamber Dictation';

const engines = new Map();
const sessions = new Map();
let ipcClosing = false;

function sendToParent(message) {
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

function sendOk(requestId, result) {
  sendToParent({ type: 'response', requestId, ok: true, ...(result !== undefined ? { result } : {}) });
}

function getEngine(modelsDir, modelId) {
  const key = `${modelsDir}:${modelId}`;
  const existing = engines.get(key);
  if (existing) {
    return existing;
  }
  const modelDir = getLocalSttModelDir(modelsDir, modelId);
  const created = new SherpaOfflineRecognizerEngine({
    encoder: `${modelDir}/encoder.int8.onnx`,
    decoder: `${modelDir}/decoder.int8.onnx`,
    joiner: `${modelDir}/joiner.int8.onnx`,
    tokens: `${modelDir}/tokens.txt`,
    numThreads: 2,
  });
  engines.set(key, created);
  return created;
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  try {
    session?.close();
  } catch {
    // ignore
  }
}

function toBuffer(audio) {
  if (Buffer.isBuffer(audio)) {
    return audio;
  }
  if (audio instanceof Uint8Array) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  if (audio && typeof audio === 'object' && audio.type === 'Buffer' && Array.isArray(audio.data)) {
    return Buffer.from(audio.data);
  }
  throw new Error('Unsupported audio payload in dictation worker');
}

async function handleRequest(message) {
  switch (message.type) {
    case 'session.create': {
      cleanupSession(message.sessionId);
      const engine = getEngine(message.modelsDir, message.modelId);
      const session = new SherpaRealtimeTranscriptionSession({ engine });
      session.on('committed', (payload) => {
        sendToParent({ type: 'session.committed', sessionId: message.sessionId, payload });
      });
      session.on('transcript', (payload) => {
        sendToParent({ type: 'session.transcript', sessionId: message.sessionId, payload });
      });
      session.on('error', (err) => {
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
      sessions.get(message.sessionId)?.appendPcm16(toBuffer(message.audio));
      sendOk(message.requestId);
      return;
    }
    case 'session.commit': {
      sessions.get(message.sessionId)?.commit();
      sendOk(message.requestId);
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
    default: {
      throw new Error(`Unknown dictation worker request: ${message?.type}`);
    }
  }
}

process.on('message', (message) => {
  void handleRequest(message).catch((error) => {
    sendToParent({
      type: 'response',
      requestId: message?.requestId,
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
  process.exit(0);
});
