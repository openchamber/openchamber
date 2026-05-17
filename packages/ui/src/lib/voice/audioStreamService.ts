/**
 * Audio Stream Service
 *
 * Captures microphone audio using MediaRecorder, detects utterance boundaries
 * via an AnalyserNode-based silence detector (VAD), then POSTs each utterance
 * as a raw audio blob to the OpenChamber server's /api/stt/transcribe endpoint.
 *
 * Mimics the BrowserVoiceService.startListening interface so useBrowserVoice
 * can swap providers without changing its internal logic.
 *
 * @example
 * ```typescript
 * audioStreamService.configure({ baseURL: 'http://localhost:8001/v1', model: 'whisper-1' });
 * audioStreamService.startListening('en', (text, isFinal) => {
 *   if (isFinal) console.log('transcript:', text);
 * });
 * audioStreamService.stopListening();
 * ```
 */

export type SpeechResultCallback = (text: string, isFinal: boolean) => void;
export type ErrorCallback = (error: string) => void;

export interface AudioStreamConfig {
  /** Base URL of the OpenAI-compatible STT server (e.g. http://localhost:8001/v1) */
  baseURL: string;
  /** Whisper-compatible model name */
  model: string;
  /** Optional BCP-47 language hint (e.g. 'en'). Empty string = auto-detect. */
  language?: string;
  /**
   * Silence threshold in dB below which audio is considered silence.
   * Lower (more negative) = only very quiet audio counts as silence.
   * Default: -45
   */
  silenceThresholdDb?: number;
  /**
   * How long continuous silence must last (ms) before the utterance is finalised.
   * Default: 1500
   */
  silenceHoldMs?: number;
}

// How often (ms) the VAD samples the analyser
const VAD_POLL_MS = 80;
// Minimum audio duration (ms) to bother uploading (avoids blank clips)
const MIN_UTTERANCE_MS = 300;

class AudioStreamService {
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

  // Configurable parameters
  private cfg: Required<AudioStreamConfig> = {
    baseURL: '',
    model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    language: '',
    silenceThresholdDb: -45,
    silenceHoldMs: 1500,
  };

  /** Update service configuration. Can be called before or after startListening. */
  configure(config: AudioStreamConfig): void {
    this.cfg = {
      silenceThresholdDb: -45,
      silenceHoldMs: 1500,
      language: '',
      ...config,
    };
  }

  /** Whether the browser supports the required APIs. */
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined' &&
      typeof window.AudioContext !== 'undefined'
    );
  }

  /**
   * Start listening. Requests microphone access if not already held.
   * Calls onResult(text, true) for each completed utterance.
   */
  async startListening(
    lang: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback
  ): Promise<void> {
    if (this.isActive) {
      this.stopListening();
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

  /** Stop listening and clean up all resources. */
  stopListening(): void {
    this._stopVAD();
    this._stopRecorder();
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

  /** Whether currently listening. */
  getIsListening(): boolean {
    return this.isActive;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

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
    try {
      this.audioContext?.close();
    } catch {
      // ignore
    }
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
      void this._upload(blob, mType).finally(() => {
        this.finishResolver?.();
        this.finishResolver = null;
      });
    };

    // Collect data every 250 ms so we don't lose the tail on stop()
    this.mediaRecorder.start(250);
  }

  private _stopRecorder(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        this.finishResolver?.();
        this.finishResolver = null;
        // ignore
      }
    }
    this.mediaRecorder = null;
  }

  private _releaseStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private _startVAD(): void {
    this._stopVAD();
    this.silenceSince = null;
    this.isSpeaking = false;

    this.vadTimer = setInterval(() => {
      if (!this.isActive || !this.analyser) return;
      const db = this._getRmsDb();
      const isSilent = db < this.cfg.silenceThresholdDb;

      if (!isSilent) {
        // Audio detected
        this.silenceSince = null;
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          // Restart recorder to capture from the start of speech
          if (this.mediaRecorder?.state === 'recording') {
            this.recordingStartMs = Date.now();
          }
        }
      } else {
        // Silence detected
        if (this.isSpeaking) {
          if (this.silenceSince === null) {
            this.silenceSince = Date.now();
          } else if (Date.now() - this.silenceSince >= this.cfg.silenceHoldMs) {
            // End of utterance — stop recorder (triggers onstop → upload)
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
    if (clearChunks) {
      this.chunks = [];
    }
    this.isSpeaking = false;
    this.silenceSince = null;
    this.onResult = null;
    this.onError = null;
    pendingResolver?.();
  }

  /** Stop the current recorder to flush the utterance, optionally restarting for the next one. */
  private _finaliseUtterance(restart: boolean): void {
    if (!this.isActive) return;
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
    if (!restart) return;

    // Restart recorder for the next utterance after a short delay
    // (MediaRecorder.onstop fires asynchronously; we wait for it to complete)
    setTimeout(() => {
      if (this.isActive && this.stream) {
        this._startRecorder();
      }
    }, 100);
  }

  /** Compute RMS of current analyser frame in dBFS. */
  private _getRmsDb(): number {
    if (!this.analyser) return -Infinity;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (const s of buf) sumSq += s * s;
    const rms = Math.sqrt(sumSq / buf.length);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms);
  }

  /** POST utterance blob to server, call onResult with transcript. */
  private async _upload(blob: Blob, mimeType: string): Promise<void> {
    if (!this.onResult) return;

    try {
      const headers: Record<string, string> = {
        'Content-Type': mimeType,
        'X-Base-URL': this.cfg.baseURL,
        'X-Model': this.cfg.model,
      };
      if (this.cfg.language) {
        headers['X-Language'] = this.cfg.language;
      } else if (this.lang && this.lang !== 'auto') {
        // Use BCP-47 base language code (e.g. 'en' from 'en-US')
        const baseLang = this.lang.split('-')[0];
        headers['X-Language'] = baseLang;
      }

      const response = await fetch('/api/stt/transcribe', {
        method: 'POST',
        headers,
        body: blob,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errData.error ?? `HTTP ${response.status}`);
      }

      const data = await response.json();
      const transcript: string = (data.transcript ?? '').trim();
      if (transcript) {
        this.onResult(transcript, true);
      }
    } catch (err) {
      if (!this.isActive) return; // Stopped — ignore
      const msg = err instanceof Error ? err.message : 'Transcription upload failed';
      console.error('[AudioStreamService] Upload error:', msg);
      this.onError?.(msg);
    }
  }

  /** Pick the best supported MIME type for MediaRecorder. */
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

export const audioStreamService = new AudioStreamService();
export { AudioStreamService };
