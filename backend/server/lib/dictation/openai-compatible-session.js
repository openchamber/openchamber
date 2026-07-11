/**
 * Pseudo-streaming transcription session for OpenAI-compatible Whisper
 * endpoints (faster-whisper, whisper.cpp, OpenAI, ...).
 *
 * The Whisper HTTP API cannot stream, so audio is buffered per segment and
 * transcribed on commit(). Live partials therefore only advance at segment
 * boundaries (the DictationStreamManager auto-commits every ~15s of speech).
 *
 * Implements the StreamingTranscriptionSession contract used by
 * DictationStreamManager.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { transcribeAudio } from '../tts/stt.js';
import { pcm16ToWav } from './audio.js';

const OPENAI_COMPATIBLE_SAMPLE_RATE = 16000;

export class OpenAICompatibleTranscriptionSession extends EventEmitter {
  /**
   * @param {{ baseURL: string, model: string, apiKey?: string, language?: string, prompt?: string }} config
   */
  constructor(config) {
    super();
    this.config = config;
    this.requiredSampleRate = OPENAI_COMPATIBLE_SAMPLE_RATE;
    this.connected = false;
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }

  async connect() {
    if (!this.config.baseURL) {
      throw new Error('Custom STT server URL is not configured');
    }
    if (!this.config.model) {
      throw new Error('STT model is not configured');
    }
    this.connected = true;
  }

  appendPcm16(chunk) {
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
