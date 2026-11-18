
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { transcribeAudio } from '../tts/stt.js';
import { normalizeCustomOpenAIBaseURL } from '../tts/base-url.js';
import { normalizeEndpointPath } from '../tts/endpoint-path.js';
import { pcm16ToWav } from './audio.js';

const OPENAI_COMPATIBLE_SAMPLE_RATE = 16000;

export interface OpenAICompatibleSessionConfig {
  baseURL: string;
  model: string;
  apiKey?: string | undefined;
  language?: string | undefined;
  prompt?: string;
  endpointPath?: string | undefined;
}

export interface OpenAICompatibleSessionEvents {
  committed: [payload: { segmentId: string; previousSegmentId: string | null }];
  transcript: [payload: { segmentId: string; transcript: string; isFinal: boolean }];
  error: [error: Error];
}

export class OpenAICompatibleTranscriptionSession extends EventEmitter<OpenAICompatibleSessionEvents> {
  declare config: OpenAICompatibleSessionConfig;
  declare requiredSampleRate: number;
  declare connected: boolean;
  declare segmentId: string;
  declare previousSegmentId: string | null;
  declare pcm16: Buffer;
  declare endpointPath: string | undefined;

  constructor(config: OpenAICompatibleSessionConfig) {
    super();
    this.config = config;
    this.requiredSampleRate = OPENAI_COMPATIBLE_SAMPLE_RATE;
    this.connected = false;
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
    this.endpointPath = undefined;
  }

  async connect() {
    if (!this.config.baseURL) {
      throw new Error('Custom STT server URL is not configured');
    }
    const url = normalizeCustomOpenAIBaseURL(this.config.baseURL);
    if (url.error) {
      throw new Error(url.error);
    }
    const endpointPath = normalizeEndpointPath(this.config.endpointPath);
    if (endpointPath.error) {
      throw new Error(endpointPath.error);
    }
    this.endpointPath = endpointPath.value;
    if (!this.config.model) {
      throw new Error('STT model is not configured');
    }
    this.connected = true;
  }

  appendPcm16(chunk: Buffer) {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
  }

  commit() {
    if (!this.connected) {
      this.emit('error', new Error('STT session not connected'));
      return;
    }

    const committedId = this.segmentId;
    const previousSegmentId = this.previousSegmentId;
    const committedPcm16 = this.pcm16;
    this.previousSegmentId = committedId;
    this.segmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);
    this.emit('committed', { segmentId: committedId, previousSegmentId });

    void (async () => {
      try {
        const wav = pcm16ToWav(committedPcm16, OPENAI_COMPATIBLE_SAMPLE_RATE);
        const text = await transcribeAudio({
          audioBuffer: wav,
          mimeType: 'audio/wav',
          model: this.config.model,
          baseURL: this.config.baseURL,
          apiKey: this.config.apiKey,
          language: this.config.language,
          endpointPath: this.endpointPath,
        });
        this.emit('transcript', {
          segmentId: committedId,
          transcript: (text ?? '').trim(),
          isFinal: true,
        });
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  clear() {
    this.pcm16 = Buffer.alloc(0);
    this.segmentId = randomUUID();
  }

  close() {
    this.connected = false;
    this.pcm16 = Buffer.alloc(0);
  }
}
