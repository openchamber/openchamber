/**
 * Streaming transcription session for the FunASR WebSocket server.
 *
 * FunASR's realtime server uses the `binary` WebSocket subprotocol: clients
 * send one JSON configuration frame followed by raw PCM16 frames. It returns
 * `2pass-online` partials and a `2pass-offline` final transcript when a
 * segment ends with `is_speaking: false`.
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

const FUNASR_SAMPLE_RATE = 16000;
const CONNECTION_TIMEOUT_MS = 10000;
const FUNASR_CHUNK_SIZE = [5, 10, 5];

function requireWebSocketUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FunASR WebSocket URL is not configured');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('FunASR WebSocket URL must use ws:// or wss://');
  }
  return url.toString();
}

function isFinalMessage(message) {
  return message.is_final === true
    || message.mode === 'offline'
    || message.mode === '2pass-offline';
}

export class FunASRWebSocketTranscriptionSession extends EventEmitter {
  /**
   * @param {{ url: string, apiKey?: string, connectionTimeoutMs?: number }} config
   */
  constructor(config) {
    super();
    this.config = config;
    this.requiredSampleRate = FUNASR_SAMPLE_RATE;
    this.connected = false;
    this.socket = null;
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.started = false;
    this.pendingFinalSegmentIds = [];
  }

  async connect() {
    const url = requireWebSocketUrl(this.config.url);
    const headers = this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : undefined;

    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url, 'binary', headers ? { headers } : undefined);
      const timeout = setTimeout(() => {
        fail(new Error('Timed out connecting to FunASR WebSocket server'));
      }, this.config.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS);

      const cleanup = () => clearTimeout(timeout);
      const fail = (error) => {
        cleanup();
        if (!settled) {
          settled = true;
          socket.terminate();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.once('open', () => {
        cleanup();
        if (settled) return;
        settled = true;
        this.socket = socket;
        this.connected = true;
        resolve();
      });
      socket.once('error', fail);
      socket.on('error', (error) => {
        if (this.connected) this.emit('error', error);
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.started = false;
        if (wasConnected) this.emit('error', new Error('FunASR WebSocket server disconnected'));
      });
    });
  }

  appendPcm16(chunk) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.emit('error', new Error('FunASR WebSocket session not connected'));
      return;
    }
    if (!this.started) this.startSegment();
    this.socket.send(chunk, { binary: true });
  }

  commit() {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.emit('error', new Error('FunASR WebSocket session not connected'));
      return;
    }

    const committedId = this.segmentId;
    const previousSegmentId = this.previousSegmentId;
    this.pendingFinalSegmentIds.push(committedId);
    this.socket.send(JSON.stringify({
      wav_name: committedId,
      is_speaking: false,
      is_end: true,
    }));
    this.previousSegmentId = committedId;
    this.segmentId = randomUUID();
    this.started = false;
    this.emit('committed', { segmentId: committedId, previousSegmentId });
  }

  clear() {
    this.segmentId = randomUUID();
    this.previousSegmentId = null;
    this.pendingFinalSegmentIds = [];
    this.started = false;
  }

  close() {
    this.connected = false;
    this.started = false;
    this.pendingFinalSegmentIds = [];
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  }

  startSegment() {
    this.socket.send(JSON.stringify({
      mode: '2pass',
      chunk_size: FUNASR_CHUNK_SIZE,
      chunk_interval: 10,
      encoder_chunk_look_back: 4,
      decoder_chunk_look_back: 1,
      wav_name: this.segmentId,
      is_speaking: true,
      hotwords: '',
      itn: true,
      audio_fs: FUNASR_SAMPLE_RATE,
    }));
    this.started = true;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.emit('error', new Error('FunASR WebSocket server sent invalid JSON'));
      return;
    }

    const transcript = typeof message.text === 'string' ? message.text.trim() : '';
    if (!transcript) return;

    const isFinal = isFinalMessage(message);
    let segmentId = typeof message.wav_name === 'string' ? message.wav_name : this.segmentId;
    if (isFinal) {
      const pendingIndex = this.pendingFinalSegmentIds.indexOf(segmentId);
      if (pendingIndex >= 0) {
        this.pendingFinalSegmentIds.splice(pendingIndex, 1);
      } else {
        segmentId = this.pendingFinalSegmentIds.shift() || segmentId;
      }
    }
    this.emit('transcript', { segmentId, transcript, isFinal });
  }
}
