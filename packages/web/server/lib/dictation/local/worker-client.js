/**
 * Client for the dictation local-speech worker process.
 *
 * Lazily forks the worker on first use, correlates request/response messages
 * by requestId, routes session events to per-session EventEmitters, and
 * shuts the worker down after an idle TTL so the ONNX runtime does not sit
 * in memory while dictation is unused.
 */

import { fork } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import { applySherpaLoaderEnv } from './sherpa-loader.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 2000;

function forkDictationWorker() {
  const env = { ...process.env };
  applySherpaLoaderEnv(env);
  return fork(fileURLToPath(new URL('./worker-process.js', import.meta.url)), [], {
    env,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
}

export class DictationWorkerClient {
  /**
   * @param {{ requestTimeoutMs?: number, idleTtlMs?: number }} [options]
   */
  constructor(options = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.pendingRequests = new Map();
    this.sessionEmitters = new Map();
    this.worker = null;
    this.stderrTail = '';
    this.inFlightRequests = 0;
    this.idleTimer = null;
    this.intentionalCloses = new WeakSet();
  }

  /**
   * Synthesize speech in the worker. Returns WAV bytes.
   * @param {{ modelsDir: string, modelId: string, text: string, speakerId?: number, speed?: number }} params
   * @returns {Promise<{ audio: Buffer, format: string }>}
   */
  async synthesizeSpeech(params) {
    // Long texts on slow hardware can exceed the default request timeout.
    const result = await this.sendRequest(
      { type: 'tts.synthesize', ...params },
      { timeoutMs: 120000 },
    );
    return {
      audio: Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio),
      format: result.format || 'audio/wav',
    };
  }

  /**
   * Create a streaming STT session in the worker.
   * @param {{ modelsDir: string, modelId: string }} params
   * @param {EventEmitter} emitter receives 'committed' | 'transcript' | 'error'
   * @returns {Promise<{ sessionId: string, requiredSampleRate: number }>}
   */
  async createSession({ modelsDir, modelId }, emitter) {
    const sessionId = randomUUID();
    this.sessionEmitters.set(sessionId, emitter);
    try {
      const result = await this.sendRequest({
        type: 'session.create',
        sessionId,
        modelsDir,
        modelId,
      });
      return { sessionId, requiredSampleRate: result?.requiredSampleRate ?? DEFAULT_LOCAL_SAMPLE_RATE };
    } catch (err) {
      this.sessionEmitters.delete(sessionId);
      this.scheduleIdleShutdownIfReady();
      throw err;
    }
  }

  appendSessionAudio(sessionId, audio) {
    void this.sendRequest({ type: 'session.append', sessionId, audio }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId) {
    void this.sendRequest({ type: 'session.commit', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId) {
    void this.sendRequest({ type: 'session.clear', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  closeSession(sessionId) {
    this.sessionEmitters.delete(sessionId);
    void this.sendRequest({ type: 'session.close', sessionId }).catch(() => {
      // Closing is best-effort; the parent already dropped the session.
    });
    this.scheduleIdleShutdownIfReady();
  }

  shutdown() {
    this.clearIdleTimer();
    this.rejectAllPending(new Error('Dictation worker shut down'));
    this.sessionEmitters.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker && !worker.killed) {
      this.intentionalCloses.add(worker);
      try {
        worker.disconnect();
      } catch {
        // ignore
      }
      try {
        worker.kill();
      } catch {
        // ignore
      }
    }
  }

  sendRequest(input, options = {}) {
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    const message = { ...input, requestId };
    this.inFlightRequests += 1;
    this.clearIdleTimer();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        reject(new Error(`Dictation worker request timed out: ${input.type}`));
      }, options.timeoutMs ?? this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      worker.send(message, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        pending.reject(error);
      });
    });
  }

  ensureWorker() {
    if (this.worker && !this.worker.killed && this.worker.connected) {
      return this.worker;
    }
    const worker = forkDictationWorker();
    this.worker = worker;
    this.stderrTail = '';
    worker.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    worker.on('message', (message) => this.handleWorkerMessage(message));
    worker.on('close', (code, signal) => this.handleWorkerExit(worker, code, signal));
    return worker;
  }

  handleWorkerMessage(message) {
    if (message?.type === 'response') {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.scheduleIdleShutdownIfReady();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || 'Dictation worker request failed'));
      }
      return;
    }

    const emitter = this.sessionEmitters.get(message?.sessionId);
    if (!emitter) {
      return;
    }
    switch (message.type) {
      case 'session.committed':
        emitter.emit('committed', message.payload);
        return;
      case 'session.transcript':
        emitter.emit('transcript', message.payload);
        return;
      case 'session.error':
        emitter.emit('error', new Error(message.error));
        return;
      default:
    }
  }

  handleWorkerExit(worker, code, signal) {
    const wasCurrentWorker = this.worker === worker;
    const wasIntentional = this.intentionalCloses.has(worker);
    this.intentionalCloses.delete(worker);
    if (!wasCurrentWorker || wasIntentional) {
      if (wasCurrentWorker) {
        this.worker = null;
      }
      return;
    }

    const stderr = this.stderrTail.trim();
    const error = new Error(
      `Dictation worker exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).` +
        (stderr ? ` Last stderr: ${stderr.slice(-500)}` : ''),
    );

    this.worker = null;
    this.clearIdleTimer();
    this.rejectAllPending(error);
    for (const emitter of this.sessionEmitters.values()) {
      if (emitter.listenerCount('error') > 0) {
        emitter.emit('error', error);
      }
    }
    this.sessionEmitters.clear();
    this.inFlightRequests = 0;
  }

  rejectAllPending(error) {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  emitSessionError(sessionId, error) {
    const emitter = this.sessionEmitters.get(sessionId);
    if (emitter && emitter.listenerCount('error') > 0) {
      emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  scheduleIdleShutdownIfReady() {
    if (!this.worker || this.inFlightRequests > 0 || this.sessionEmitters.size > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.inFlightRequests === 0 && this.sessionEmitters.size === 0) {
        this.shutdown();
      }
    }, this.idleTtlMs);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * StreamingTranscriptionSession backed by the worker process.
 * Matches the session contract consumed by DictationStreamManager.
 */
export class WorkerBackedTranscriptionSession extends EventEmitter {
  /**
   * @param {DictationWorkerClient} client
   * @param {{ modelsDir: string, modelId: string }} modelConfig
   */
  constructor(client, modelConfig) {
    super();
    this.client = client;
    this.modelConfig = modelConfig;
    this.requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
    this.connectedSessionId = null;
    this.connecting = null;
  }

  async connect() {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const result = await this.client.createSession(this.modelConfig, this);
          this.connectedSessionId = result.sessionId;
          this.requiredSampleRate = result.requiredSampleRate;
        } finally {
          this.connecting = null;
        }
      })();
    }
    await this.connecting;
  }

  appendPcm16(pcm16le) {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('Local STT session not connected'));
      return;
    }
    this.client.appendSessionAudio(this.connectedSessionId, pcm16le);
  }

  commit() {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('Local STT session not connected'));
      return;
    }
    this.client.commitSession(this.connectedSessionId);
  }

  clear() {
    if (this.connectedSessionId) {
      this.client.clearSession(this.connectedSessionId);
    }
  }

  close() {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}
