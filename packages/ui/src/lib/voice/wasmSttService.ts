/**
 * WASM Speech-to-Text Service
 *
 * Local Whisper transcription via Transformers.js (ONNX Runtime Web).
 * Captures microphone audio, detects utterance boundaries via silence-based
 * VAD, then transcribes each utterance locally — no cloud API required.
 *
 * Works in Electron and all modern browsers that support Web Audio API.
 * First use downloads a Whisper model (~40–166 MB, cached).
 */

export type WasmModelStatus =
  | { state: 'unloaded' }
  | { state: 'downloading'; progress: number }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; error: string };

export interface WasmModelInfo {
  id: string;
  name: string;
  size: string;
  languages: string;
  description: string;
}

export const WASM_MODELS: WasmModelInfo[] = [
  {
    id: 'Xenova/whisper-tiny.en',
    name: 'Whisper Tiny (EN)',
    size: '~39 MB',
    languages: 'English',
    description: 'Fastest, lowest accuracy. Good for quick dictation.',
  },
  {
    id: 'Xenova/whisper-base.en',
    name: 'Whisper Base (EN)',
    size: '~73 MB',
    languages: 'English',
    description: 'Balanced speed and accuracy. Default for English.',
  },
  {
    id: 'Xenova/whisper-small.en',
    name: 'Whisper Small (EN)',
    size: '~166 MB',
    languages: 'English',
    description: 'Higher accuracy, slower. Best for noisy environments.',
  },
];

export type SpeechResultCallback = (text: string, isFinal: boolean) => void;
export type ErrorCallback = (error: string) => void;

const VAD_POLL_MS = 80;
const MIN_UTTERANCE_MS = 300;
const WHISPER_SAMPLE_RATE = 16000;

interface WasmSttConfig {
  silenceThresholdDb?: number;
  silenceHoldMs?: number;
}

class WasmSttService {
  private transcriber: unknown = null;
  private worker: Worker | null = null;
  private modelStatus: WasmModelStatus = { state: 'unloaded' };
  private currentModelId: string | null = null;

  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private recordingStartMs = 0;
  private isActive = false;
  private isSpeaking = false;
  private silenceSince: number | null = null;
  private onResult: SpeechResultCallback | null = null;
  private onError: ErrorCallback | null = null;
  private finishResolver: (() => void) | null = null;
  private lang = 'en';

  private cfg: Required<WasmSttConfig> = {
    silenceThresholdDb: -45,
    silenceHoldMs: 1500,
  };

  public onModelStatusChange: ((status: WasmModelStatus) => void) | null = null;

  configure(config: WasmSttConfig): void {
    this.cfg = { ...this.cfg, ...config };
  }

  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined' &&
      typeof window.AudioContext !== 'undefined'
    );
  }

  getModelStatus(): WasmModelStatus {
    return this.modelStatus;
  }

  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  private setModelStatus(status: WasmModelStatus): void {
    this.modelStatus = status;
    this.onModelStatusChange?.(status);
  }

  async loadModel(modelId: string): Promise<void> {
    if (this.currentModelId === modelId && this.modelStatus.state === 'ready') {
      return;
    }

    if (this.modelStatus.state === 'downloading' || this.modelStatus.state === 'loading') {
      return;
    }

    this._terminateWorker();
    this.transcriber = null;

    this.setModelStatus({ state: 'downloading', progress: 0 });
    this.currentModelId = modelId;

    // Try Web Worker first — inference off main thread = no UI freeze.
    try {
      const WasmWorkerMod = await import('./wasmSttWorker?worker');
      const WasmWorker = WasmWorkerMod.default as new () => Worker;
      this.worker = new WasmWorker();

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker init timed out')), 10000);

        this.worker!.onmessage = (e: MessageEvent) => {
          const data = e.data as { type: string; progress?: number; error?: string; text?: string };
          if (data.type === 'progress') {
            this.setModelStatus({ state: 'downloading', progress: data.progress ?? 0 });
          } else if (data.type === 'loaded') {
            clearTimeout(timer);
            resolve();
          } else if (data.type === 'error') {
            clearTimeout(timer);
            reject(new Error(data.error ?? 'Worker load failed'));
          }
        };

        this.worker!.onerror = (err) => {
          clearTimeout(timer);
          reject(new Error(err.message || 'Worker error'));
        };

        this.worker!.postMessage({ type: 'load', modelId });
      });

      this.setModelStatus({ state: 'ready' });
      return;
    } catch (err) {
      console.warn('[WasmStt] Worker failed, using main-thread:', err instanceof Error ? err.message : err);
      this._terminateWorker();
    }

    // Fallback: main-thread pipeline (causes brief UI freeze during inference).
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.backends.onnx.wasm.numThreads = 1;
      env.allowLocalModels = false;

      const fileDoneBytes = new Map<string, number>();
      let totalDone = 0;
      let totalEstimate = 0;

      this.transcriber = await pipeline('automatic-speech-recognition', modelId, {
        progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (info.status === 'progress' && info.file) {
            const prevDone = fileDoneBytes.get(info.file) ?? 0;
            const currentDone = info.loaded ?? 0;
            const delta = Math.max(0, currentDone - prevDone);
            fileDoneBytes.set(info.file, currentDone);
            totalDone += delta;
            if (info.total && info.total > totalEstimate) totalEstimate = info.total;
            const effectiveTotal = Math.max(totalEstimate, totalDone);
            const pct = effectiveTotal > 0 ? Math.min(100, Math.round((totalDone / effectiveTotal) * 100)) : 0;
            this.setModelStatus({ state: 'downloading', progress: pct });
          }
        },
      });

      this.setModelStatus({ state: 'ready' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error loading model';
      this.setModelStatus({ state: 'error', error: msg });
      this.transcriber = null;
      this.currentModelId = null;
      throw err;
    }
  }

  private _terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  async unloadModel(): Promise<void> {
    this._terminateWorker();
    this.transcriber = null;
    this.currentModelId = null;
    this.setModelStatus({ state: 'unloaded' });
  }

  async startListening(
    lang: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback,
  ): Promise<void> {
    if (this.isActive) {
      this.stopListening();
    }

    if (!this.transcriber && !this.worker) {
      onError?.('Whisper model not loaded. Select a model in Voice Settings first.');
      return;
    }

    this.lang = lang;
    this.onResult = onResult;
    this.onError = onError ?? null;
    this.isActive = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      this.isActive = false;
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      onError?.(msg);
      return;
    }

    this._setupAudioContext();
    this._startRecorder();
    this._startVAD();
  }

  stopListening(): void {
    this._stopVAD();
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop(); } catch { /* ignore */ }
    }
    this._cleanupAfterStop(true);
  }

  async finishListening(): Promise<void> {
    if (!this.isActive) return;

    this._stopVAD();
    this.isSpeaking = false;
    this.silenceSince = null;

    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      this._cleanupAfterStop(true);
      return;
    }

    await new Promise<void>((resolve) => {
      this.finishResolver = resolve;
      this._finaliseUtterance(false);
    });

    this._cleanupAfterStop(true);
  }

  getIsListening(): boolean {
    return this.isActive;
  }

  // ── Audio capture ────────────────────────────────────────────────────

  private _setupAudioContext(): void {
    if (!this.stream) return;
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
  }

  private _teardownAudioContext(): void {
    try { this.audioContext?.close(); } catch { /* ignore */ }
    this.audioContext = null;
    this.analyser = null;
  }

  private _startRecorder(): void {
    if (!this.stream) return;
    const mimeType = this._pickMimeType();
    const options: MediaRecorderOptions = {};
    if (mimeType && MediaRecorder.isTypeSupported(mimeType)) {
      options.mimeType = mimeType;
    }
    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.recordingStartMs = Date.now();

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blobs = this.chunks.splice(0);
      const durationMs = Date.now() - this.recordingStartMs;
      if (blobs.length === 0 || durationMs < MIN_UTTERANCE_MS) {
        this.finishResolver?.();
        this.finishResolver = null;
        return;
      }
      const mType = blobs[0].type || mimeType || 'audio/webm';
      const blob = new Blob(blobs, { type: mType });
      void this._transcribe(blob).finally(() => {
        this.finishResolver?.();
        this.finishResolver = null;
      });
    };

    this.mediaRecorder.start(250);
  }

  private _releaseStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  // ── VAD ──────────────────────────────────────────────────────────────

  private _startVAD(): void {
    this._stopVAD();
    this.silenceSince = null;
    this.isSpeaking = false;

    this.vadTimer = setInterval(() => {
      if (!this.isActive || !this.analyser) return;
      const db = this._getRmsDb();
      const isSilent = db < this.cfg.silenceThresholdDb;

      if (!isSilent) {
        this.silenceSince = null;
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          if (this.mediaRecorder?.state === 'recording') {
            this.recordingStartMs = Date.now();
          }
        }
      } else {
        if (this.isSpeaking) {
          if (this.silenceSince === null) {
            this.silenceSince = Date.now();
          } else if (Date.now() - this.silenceSince >= this.cfg.silenceHoldMs) {
            this.isSpeaking = false;
            this.silenceSince = null;
            this._finaliseUtterance(true);
          }
        }
      }
    }, VAD_POLL_MS);
  }

  private _stopVAD(): void {
    if (this.vadTimer !== null) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
  }

  private _cleanupAfterStop(clearChunks: boolean): void {
    const pendingResolver = this.finishResolver;
    this.isActive = false;
    this.finishResolver = null;
    this.mediaRecorder = null;
    this._teardownAudioContext();
    this._releaseStream();
    if (clearChunks) this.chunks = [];
    this.isSpeaking = false;
    this.silenceSince = null;
    this.onResult = null;
    this.onError = null;
    pendingResolver?.();
  }

  private _finaliseUtterance(restart: boolean): void {
    if (!this.isActive) return;
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
    if (!restart) return;
    setTimeout(() => {
      if (this.isActive && this.stream) {
        this._startRecorder();
      }
    }, 100);
  }

  private _getRmsDb(): number {
    if (!this.analyser) return -Infinity;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (const s of buf) sumSq += s * s;
    const rms = Math.sqrt(sumSq / buf.length);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms);
  }

  // ── Transcription ────────────────────────────────────────────────────

  private async _transcribe(blob: Blob): Promise<void> {
    if (!this.onResult) return;
    if (!this.transcriber && !this.worker) {
      this.onError?.('Model not loaded');
      return;
    }

    try {
      const audioData = await this._decodeToFloat32(blob);
      if (!audioData || audioData.length === 0) {
        this.onError?.(`Failed to decode audio (${blob.size} bytes)`);
        return;
      }

      const langHint = this._resolveLanguageHint();

      // Prefer worker (non-blocking); fall back to main-thread pipeline.
      const transcript = this.worker
        ? await this._transcribeViaWorker(audioData, langHint)
        : await this._transcribeMainThread(audioData, langHint);

      if (transcript) {
        this.onResult(transcript, true);
      }
    } catch (err) {
      if (!this.isActive) return;
      const msg = err instanceof Error ? err.message : 'Local transcription failed';
      this.onError?.(msg);
    }
  }

  private _transcribeViaWorker(audioData: Float32Array, langHint: string | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker gone'));

      const onMessage = (e: MessageEvent) => {
        const data = e.data as { type: string; error?: string; transcript?: string; text?: string };
        if (data.type === 'result') {
          this.worker!.removeEventListener('message', onMessage);
          resolve(data.transcript ?? '');
        } else if (data.type === 'log') {
          console.log('[WasmStt Worker]', data.text);
        } else if (data.type === 'error') {
          this.worker!.removeEventListener('message', onMessage);
          reject(new Error(data.error ?? 'Transcription failed'));
        }
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage(
        { type: 'transcribe', audio: audioData.buffer, language: langHint },
        [audioData.buffer],
      );

      setTimeout(() => {
        this.worker?.removeEventListener('message', onMessage);
        reject(new Error('Transcription timed out'));
      }, 30000);
    });
  }

  private async _transcribeMainThread(audioData: Float32Array, langHint: string | undefined): Promise<string> {
    const pipelineFn = this.transcriber as (
      input: Float32Array,
      options?: Record<string, unknown>,
    ) => Promise<{ text: string }>;

    const result = await pipelineFn(audioData, {
      task: 'transcribe',
      ...(langHint ? { language: langHint } : {}),
    });

    return (result?.text ?? '').trim();
  }

  private async _decodeToFloat32(blob: Blob): Promise<Float32Array | null> {
    if (!this.audioContext) return null;
    const arrayBuffer = await blob.arrayBuffer();
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    } catch {
      return null;
    }

    const origRate = audioBuffer.sampleRate;
    const origData = audioBuffer.getChannelData(0);
    const targetRate = WHISPER_SAMPLE_RATE;

    if (origRate === targetRate) {
      return new Float32Array(origData);
    }

    const ratio = origRate / targetRate;
    const newLength = Math.ceil(origData.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const origIdx = i * ratio;
      const idx0 = Math.floor(origIdx);
      const idx1 = Math.min(idx0 + 1, origData.length - 1);
      const frac = origIdx - idx0;
      result[i] = origData[idx0] * (1 - frac) + origData[idx1] * frac;
    }
    return result;
  }

  private _resolveLanguageHint(): string | undefined {
    if (this.lang && this.lang !== 'auto') {
      return this.lang.split('-')[0];
    }
    return undefined;
  }

  private _pickMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    }
    return '';
  }
}

export const wasmSttService = new WasmSttService();
export { WasmSttService };
