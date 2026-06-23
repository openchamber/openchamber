/**
 * useServerTTS Hook — Streaming edition
 *
 * Fetches audio from the server using streaming (ReadableStream) and plays
 * it progressively via Web Audio API. Supports pause/resume without closing
 * the HTTP connection, and stop which cancels the connection.
 *
 * Audio format detection:
 * - WAV (16-bit PCM): parsed from header, PCM chunks fed to AudioBufferSourceNodes
 * - MP3 / other: falls back to blob → decodeAudioData (non-streaming)
 *
 * @example
 * ```typescript
 * const { speak, isPlaying, isPaused, pause, resume, stop, isAvailable } = useServerTTS();
 * await speak('Hello world');
 * pause();  // connection stays open, audio pauses
 * resume(); // audio continues
 * stop();   // connection closes, audio stops
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { runtimeFetch } from '@/lib/runtime-fetch';

interface ServerTTSStatusCache {
  available: boolean;
  checkedAt: number;
}

interface UseServerTTSOptions {
  enabled?: boolean;
  availabilityMode?: 'auto' | 'openai' | 'openai-compatible';
}

const SERVER_TTS_STATUS_TTL_MS = 30000;
let serverTTSStatusCache: ServerTTSStatusCache | null = null;
let serverTTSStatusRequest: Promise<boolean> | null = null;

async function getServerTTSStatus(): Promise<boolean> {
  const now = Date.now();
  if (serverTTSStatusCache && now - serverTTSStatusCache.checkedAt < SERVER_TTS_STATUS_TTL_MS) {
    return serverTTSStatusCache.available;
  }

  if (serverTTSStatusRequest) {
    return serverTTSStatusRequest;
  }

  serverTTSStatusRequest = (async () => {
    try {
      const response = await runtimeFetch('/api/tts/status');
      if (!response.ok) {
        serverTTSStatusCache = { available: false, checkedAt: Date.now() };
        return false;
      }

      const data = await response.json();
      const available = Boolean(data.available);
      serverTTSStatusCache = { available, checkedAt: Date.now() };
      return available;
    } catch {
      serverTTSStatusCache = { available: false, checkedAt: Date.now() };
      return false;
    } finally {
      serverTTSStatusRequest = null;
    }
  })();

  return serverTTSStatusRequest;
}

// ─── WAV helpers ──────────────────────────────────────────────────────────── //

const WAV_HEADER_SIZE = 44;

interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
}

function parseWavHeader(buf: Uint8Array): WavInfo | null {
  if (buf.length < WAV_HEADER_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const riff = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (riff !== 'RIFF') return null;
  return {
    sampleRate: view.getUint32(24, true),
    numChannels: view.getUint16(22, true),
    bitsPerSample: view.getUint16(34, true),
  };
}

function pcm16ToAudioBuffer(
  ctx: AudioContext,
  data: Uint8Array,
  wavInfo: WavInfo,
): AudioBuffer {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytesPerSample = wavInfo.bitsPerSample / 8;
  const numSamples = Math.floor(data.byteLength / (wavInfo.numChannels * bytesPerSample));
  const buffer = ctx.createBuffer(wavInfo.numChannels, numSamples, wavInfo.sampleRate);

  for (let ch = 0; ch < wavInfo.numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < numSamples; i++) {
      const offset = (i * wavInfo.numChannels + ch) * bytesPerSample;
      channelData[i] = view.getInt16(offset, true) / 32768;
    }
  }
  return buffer;
}

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

// ─── Hook ──────────────────────────────────────────────────────────────────── //

export interface UseServerTTSReturn {
  isPlaying: boolean;
  isPaused: boolean;
  isAvailable: boolean;
  error: string | null;
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  checkAvailability: () => Promise<boolean>;
  unlockAudio: () => Promise<void>;
}

export interface SpeakOptions {
  voice?: string;
  model?: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  instructions?: string;
  summarize?: boolean;
  providerId?: string;
  modelId?: string;
  threshold?: number;
  baseURL?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return sharedAudioContext;
}

// Minimum PCM bytes to accumulate before scheduling a playback chunk
const MIN_PCM_CHUNK_BYTES = 8192;

export function useServerTTS(options: UseServerTTSOptions = {}): UseServerTTSReturn {
  const enabled = options.enabled ?? true;
  const availabilityMode = options.availabilityMode ?? 'auto';
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const gainNodeRef = useRef<GainNode | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const nextStartTimeRef = useRef(0);
  const playbackEndedRef = useRef(false);

  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
  const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
  const openaiCompatibleApiKey = useConfigStore((state) => state.openaiCompatibleApiKey);

  const checkAvailability = useCallback(async (): Promise<boolean> => {
    if (!enabled) {
      setIsAvailable(false);
      return false;
    }

    const hasClientKey = Boolean(openaiApiKey && openaiApiKey.trim().length > 0);
    const hasCustomUrl = Boolean(openaiCompatibleUrl && openaiCompatibleUrl.trim().length > 0);
    if (availabilityMode === 'openai-compatible') {
      setIsAvailable(hasCustomUrl);
      return hasCustomUrl;
    }

    if (hasClientKey) {
      setIsAvailable(true);
      return true;
    }

    if (availabilityMode === 'auto' && hasCustomUrl) {
      setIsAvailable(true);
      return true;
    }

    try {
      const hasServerKey = await getServerTTSStatus();
      setIsAvailable(hasServerKey);
      return hasServerKey;
    } catch {
      setIsAvailable(false);
      return false;
    }
  }, [availabilityMode, enabled, openaiApiKey, openaiCompatibleUrl]);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const stop = useCallback(() => {
    // Stop all active source nodes
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* */ }
    }
    activeSourcesRef.current = [];

    // Cancel reader (closes the HTTP connection)
    if (readerRef.current) {
      readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setIsPlaying(false);
    setIsPaused(false);
  }, []);

  const pause = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'running') {
      ctx.suspend();
      setIsPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
      setIsPaused(false);
    }
  }, []);

  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (err) {
      console.error('[useServerTTS] Failed to unlock audio:', err);
    }
  }, []);

  const speak = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);
    playbackEndedRef.current = false;

    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // Silent buffer to unlock iOS audio
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);

      abortControllerRef.current = new AbortController();

      // Gain node for volume control
      const gainNode = ctx.createGain();
      gainNode.gain.value = options?.volume ?? 1.0;
      gainNode.connect(ctx.destination);
      gainNodeRef.current = gainNode;

      const voice = options?.voice || 'nova';
      console.log('[useServerTTS] Speaking (streaming) voice:', voice);

      const response = await runtimeFetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          voice,
          model: options?.model || undefined,
          speed: options?.speed || 0.9,
          instructions: options?.instructions,
          summarize: false,
          providerId: options?.providerId || currentProviderId || undefined,
          modelId: options?.modelId || currentModelId || undefined,
          apiKey: options?.baseURL ? (openaiCompatibleApiKey || undefined) : (openaiApiKey || undefined),
          baseURL: options?.baseURL || undefined,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      setIsPlaying(true);
      setIsPaused(false);
      options?.onStart?.();

      // Check if response supports streaming
      if (!response.body) {
        // No streaming support — fallback to blob + decodeAudioData
        console.log('[useServerTTS] No streaming body, falling back to blob');
        const audioBlob = await response.blob();
        const arrayBuffer = await audioBlob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const pitch = options?.pitch ?? 1.0;
        if (pitch !== 1.0) source.detune.value = (pitch - 1.0) * 1200;
        source.connect(gainNode);
        activeSourcesRef.current.push(source);
        source.onended = () => {
          setIsPlaying(false);
          options?.onEnd?.();
        };
        source.start(0);
        return;
      }

      // ── Streaming playback ────────────────────────────────────────────────
      const reader = response.body.getReader();
      readerRef.current = reader;

      let headerBuffer: Uint8Array = new Uint8Array(0);
      let wavInfo: WavInfo | null = null;
      let pcmAccumulator: Uint8Array = new Uint8Array(0);
      let isWav = false;
      let nonWavBuffer: Uint8Array = new Uint8Array(0);

      nextStartTimeRef.current = ctx.currentTime + 0.05;

      const flushPcmBuffer = () => {
        if (pcmAccumulator.length === 0 || !wavInfo) return;
        const audioBuffer = pcm16ToAudioBuffer(ctx, pcmAccumulator, wavInfo);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const pitch = options?.pitch ?? 1.0;
        if (pitch !== 1.0) source.detune.value = (pitch - 1.0) * 1200;
        source.connect(gainNode);
        activeSourcesRef.current.push(source);

        const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime);
        source.start(startTime);
        nextStartTimeRef.current = startTime + audioBuffer.duration;
        pcmAccumulator = new Uint8Array(0);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          if (!isWav && wavInfo === null) {
            // First chunk: detect format
            headerBuffer = concatUint8(headerBuffer, value);

            if (headerBuffer.length >= 4) {
              const riff = String.fromCharCode(
                headerBuffer[0], headerBuffer[1], headerBuffer[2], headerBuffer[3],
              );
              if (riff === 'RIFF') {
                isWav = true;
                if (headerBuffer.length >= WAV_HEADER_SIZE) {
                  wavInfo = parseWavHeader(headerBuffer);
                  const pcm = headerBuffer.slice(WAV_HEADER_SIZE);
                  headerBuffer = new Uint8Array(0);
                  if (pcm.length > 0) {
                    pcmAccumulator = concatUint8(pcmAccumulator, pcm);
                  }
                }
              } else {
                // Not WAV — fallback to blob
                console.log('[useServerTTS] Non-WAV format, accumulating for blob fallback');
                wavInfo = null;
                nonWavBuffer = headerBuffer;
                headerBuffer = new Uint8Array(0);
              }
            }
            continue;
          }

          if (isWav && wavInfo) {
            // Progressive WAV playback
            pcmAccumulator = concatUint8(pcmAccumulator, value);
            if (pcmAccumulator.length >= MIN_PCM_CHUNK_BYTES) {
              flushPcmBuffer();
            }
          } else {
            // Non-WAV: accumulate for blob fallback
            nonWavBuffer = concatUint8(nonWavBuffer, value);
          }
        }

        // Flush remaining PCM
        if (isWav && wavInfo) {
          flushPcmBuffer();
          // Schedule onEnded on the last source
          const lastSource = activeSourcesRef.current[activeSourcesRef.current.length - 1];
          if (lastSource) {
            lastSource.onended = () => {
              if (!playbackEndedRef.current) {
                playbackEndedRef.current = true;
                setIsPlaying(false);
                options?.onEnd?.();
              }
            };
          } else {
            setIsPlaying(false);
            options?.onEnd?.();
          }
        } else if (nonWavBuffer.length > 0) {
          // Non-WAV fallback: decode complete blob
          console.log('[useServerTTS] Decoding non-WAV blob:', nonWavBuffer.length, 'bytes');
          const audioBuffer = await ctx.decodeAudioData(nonWavBuffer.buffer.slice(0) as ArrayBuffer);
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          const pitch = options?.pitch ?? 1.0;
          if (pitch !== 1.0) source.detune.value = (pitch - 1.0) * 1200;
          source.connect(gainNode);
          activeSourcesRef.current.push(source);
          source.onended = () => {
            if (!playbackEndedRef.current) {
              playbackEndedRef.current = true;
              setIsPlaying(false);
              options?.onEnd?.();
            }
          };
          source.start(0);
        }
      } finally {
        readerRef.current = null;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
      console.error('[useServerTTS] Error:', errorMsg);
      setError(errorMsg);
      options?.onError?.(errorMsg);
      setIsPlaying(false);
    }
  }, [stop, currentProviderId, currentModelId, openaiApiKey, openaiCompatibleApiKey]);

  useEffect(() => {
    return () => { stop(); };
  }, [stop]);

  return {
    isPlaying,
    isPaused,
    isAvailable,
    error,
    speak,
    stop,
    pause,
    resume,
    checkAvailability,
    unlockAudio,
  };
}
