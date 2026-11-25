import { fork } from 'child_process';
import type { ChildProcess, ForkOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import { applySherpaLoaderEnv } from './sherpa-loader.js';
import {
  committedPayloadSchema,
  createSessionResultSchema,
  responseHeadSchema,
  synthesizeResultSchema,
  transcriptPayloadSchema,
  workerMessageSchema,
} from './worker-protocol.js';
import type { WorkerMessage } from './worker-protocol.js';

type WorkerResponseResult = Extract<WorkerMessage, { type: 'response' }>['result'];

interface PendingRequest {
  resolve: (result: WorkerResponseResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

type WorkerInput =
  | { type: 'tts.synthesize'; modelsDir: string; modelId: string; text: string; speakerId?: number | undefined; speed?: number | undefined }
  | { type: 'session.create'; sessionId: string; modelsDir: string; modelId: string; language?: unknown }
  | { type: 'session.append'; sessionId: string; audio: Buffer }
  | { type: 'session.commit' | 'session.clear' | 'session.close'; sessionId: string };

export interface LocalModelConfig {
  modelsDir: string;
  modelId: string;
  language?: unknown;
}

const malformedResult = (type: string) => new Error(`Dictation worker answered ${type} with a malformed result`);

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 2000;

function quietly(action: () => void) {
  try {
    action();
  } catch {
    return;
  }
}

function forkDictationWorker() {
  const env = { ...process.env };
  applySherpaLoaderEnv(env);
  const options: ForkOptions & { windowsHide: boolean } = {
    env,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  };
  return fork(fileURLToPath(new URL('./worker-process.js', import.meta.url)), [], options);
}

export class DictationWorkerClient {
  requestTimeoutMs: number;
  idleTtlMs: number;
  pendingRequests: Map<string, PendingRequest>;
  sessionEmitters: Map<string, EventEmitter>;
  worker: ChildProcess | null;
  stderrTail: string;
  inFlightRequests: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  intentionalCloses: WeakSet<ChildProcess>;

  constructor(options: { requestTimeoutMs?: number; idleTtlMs?: number } = {}) {
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

  async synthesizeSpeech(params: { modelsDir: string; modelId: string; text: string; speakerId?: number | undefined; speed?: number | undefined }) {
    const parsed = synthesizeResultSchema.safeParse(await this.sendRequest(
      { type: 'tts.synthesize', ...params },
      { timeoutMs: 120000 },
    ));
    if (!parsed.success) {
      throw malformedResult('tts.synthesize');
    }
    const { audio, format } = parsed.data;
    return {
      audio: Buffer.isBuffer(audio) ? audio : Buffer.from(audio),
      format: format || 'audio/wav',
    };
  }

  async createSession({ modelsDir, modelId, language }: LocalModelConfig, emitter: EventEmitter) {
    const sessionId = randomUUID();
    try {
      const created = this.sendRequest({
        type: 'session.create',
        sessionId,
        modelsDir,
        modelId,
        language,
      });
      this.sessionEmitters.set(sessionId, emitter);
      const result = await created;
      return { sessionId, requiredSampleRate: createSessionResultSchema.parse(result)?.requiredSampleRate ?? DEFAULT_LOCAL_SAMPLE_RATE };
    } catch (err) {
      this.sessionEmitters.delete(sessionId);
      this.scheduleIdleShutdownIfReady();
      throw err;
    }
  }

  appendSessionAudio(sessionId: string, audio: Buffer) {
    if (!this.sessionWorker()) return;
    void this.sendRequest({ type: 'session.append', sessionId, audio }, { timeoutMs: 0 }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId: string) {
    if (!this.sessionWorker()) return;
    void this.sendRequest({ type: 'session.commit', sessionId }, { timeoutMs: 0 }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId: string) {
    if (!this.sessionWorker()) return;
    void this.sendRequest({ type: 'session.clear', sessionId }, { timeoutMs: 0 }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  closeSession(sessionId: string) {
    this.sessionEmitters.delete(sessionId);
    if (this.liveWorker()) {
      void this.sendRequest({ type: 'session.close', sessionId }, { timeoutMs: 0 }).catch(() => undefined);
    }
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
      quietly(() => worker.disconnect());
      quietly(() => worker.kill());
    }
  }

  sendRequest(input: WorkerInput, options: { timeoutMs?: number } = {}) {
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    const message = { ...input, requestId };
    this.inFlightRequests += 1;
    this.clearIdleTimer();

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<WorkerResponseResult>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(requestId);
              this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
              this.scheduleIdleShutdownIfReady();
              reject(new Error(`Dictation worker request timed out: ${input.type}`));
            }, timeoutMs)
          : undefined;

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

  liveWorker() {
    return this.worker && !this.worker.killed && this.worker.connected ? this.worker : null;
  }

  sessionWorker() {
    const live = this.liveWorker();
    if (!live && this.worker) {
      this.handleWorkerExit(this.worker, null, null);
    }
    return live;
  }

  ensureWorker() {
    const live = this.sessionWorker();
    if (live) {
      return live;
    }
    const worker = forkDictationWorker();
    this.worker = worker;
    this.stderrTail = '';
    worker.stderr?.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    worker.on('message', (message) => this.handleWorkerMessage(message));
    worker.on('close', (code, signal) => this.handleWorkerExit(worker, code, signal));
    return worker;
  }

  handleWorkerMessage<Raw>(raw: Raw) {
    const parsed = workerMessageSchema.safeParse(raw);
    if (parsed.success) {
      this.dispatchWorkerMessage(parsed.data);
      return;
    }
    const { requestId } = responseHeadSchema.parse(raw);
    if (requestId !== undefined && this.pendingRequests.has(requestId)) {
      this.dispatchWorkerMessage({ type: 'response', requestId, ok: false, error: 'Dictation worker sent a malformed response' });
    }
  }

  dispatchWorkerMessage(message: WorkerMessage) {
    if (message.type === 'response') {
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

    const emitter = this.sessionEmitters.get(message.sessionId);
    if (!emitter) {
      return;
    }
    switch (message.type) {
      case 'session.committed': {
        const payload = committedPayloadSchema.safeParse(message.payload);
        if (payload.success) emitter.emit('committed', payload.data);
        else emitter.emit('error', new Error('Dictation worker sent a malformed committed segment'));
        return;
      }
      case 'session.transcript': {
        const payload = transcriptPayloadSchema.safeParse(message.payload);
        if (payload.success) emitter.emit('transcript', payload.data);
        else emitter.emit('error', new Error('Dictation worker sent a malformed transcript'));
        return;
      }
      case 'session.error':
        emitter.emit('error', new Error(message.error));
    }
  }

  handleWorkerExit(worker: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
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

  rejectAllPending(error: Error) {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  emitSessionError<Cause>(sessionId: string, error: Cause) {
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

export class WorkerBackedTranscriptionSession extends EventEmitter {
  client: DictationWorkerClient;
  modelConfig: LocalModelConfig;
  requiredSampleRate: number;
  connectedSessionId: string | null;
  connecting: Promise<void> | null;

  constructor(client: DictationWorkerClient, modelConfig: LocalModelConfig) {
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

  appendPcm16(pcm16le: Buffer) {
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
