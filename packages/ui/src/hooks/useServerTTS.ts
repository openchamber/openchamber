/**
 * useServerTTS Hook
 * 
 * React hook for server-side text-to-speech playback.
 * Fetches audio from the server and plays it, bypassing mobile Safari restrictions.
 * Supports streaming playback with pause/resume for WAV-format audio.
 * 
 * @example
 * ```typescript
 * const { speak, isPlaying, isPaused, pause, resume, stop, isAvailable } = useServerTTS();
 * 
 * // Speak text
 * await speak('Hello, this is a test');
 * 
 * // Pause playback (connection stays alive)
 * pause();
 * 
 * // Resume playback
 * resume();
 * 
 * // Stop playback (closes connection)
 * stop();
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

// ─── WAV streaming helpers ──────────────────────────────────────────────────

export const WAV_HEADER_SIZE = 44;
// Minimum PCM bytes to accumulate before scheduling a playback chunk
export const MIN_PCM_CHUNK_BYTES = 8192;

export interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
}

/** Parse WAV header from first 44 bytes. Returns null if not valid WAV. */
export function parseWavHeader(buf: Uint8Array): WavInfo | null {
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

/** Convert 16-bit PCM bytes to an AudioBuffer */
export function pcm16ToAudioBuffer(
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

export function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

export interface UseServerTTSReturn {
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Whether TTS is currently paused (connection still alive) */
  isPaused: boolean;
  /** Whether the server TTS service is available */
  isAvailable: boolean;
  /** Current error if any */
  error: string | null;
  /** Speak the given text */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** Stop current playback and close the connection */
  stop: () => void;
  /** Pause playback (keeps HTTP connection alive) */
  pause: () => void;
  /** Resume playback after pause */
  resume: () => void;
  /** Check if service is available */
  checkAvailability: () => Promise<boolean>;
  /** Unlock audio for mobile Safari - call this on user gesture before speaking */
  unlockAudio: () => Promise<void>;
}

interface SpeakOptions {
  /** Voice to use (defaults to coral) */
  voice?: string;
  /** Model to use (defaults to gpt-4o-mini-tts) */
  model?: string;
  /** Speech speed (0.25 to 4.0, defaults to 1.0) */
  speed?: number;
  /** Speech pitch shift (0.5 to 2.0, mapped to cents; 1.0 = no shift) */
  pitch?: number;
  /** Playback volume (0 to 1, defaults to 1.0) */
  volume?: number;
  /** Optional instructions for the voice */
  instructions?: string;
  /** Summarize long text before speaking (defaults to true) */
  summarize?: boolean;
  /** Provider ID for summarization model */
  providerId?: string;
  /** Model ID for summarization */
  modelId?: string;
  /** Character threshold for summarization (defaults to 200) */
  threshold?: number;
  /** Custom base URL for OpenAI-compatible server */
  baseURL?: string;
  /** Callback when playback starts */
  onStart?: () => void;
  /** Callback when playback ends */
  onEnd?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

// Shared AudioContext for Web Audio API playback (better iOS support)
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return sharedAudioContext;
}

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
  
  // Get current model and API settings from config store.
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
  const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
  const openaiCompatibleApiKey = useConfigStore((state) => state.openaiCompatibleApiKey);

  // Check if server TTS is available
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

  // Check availability on mount and when API key changes
  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // Stop current playback
  const stop = useCallback(() => {
    // Stop all active Web Audio API source nodes
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
      try {
        src.disconnect();
      } catch {
        // Already disconnected
      }
    }
    activeSourcesRef.current = [];

    // Disconnect gain node from destination to prevent audio graph leaks
    if (gainNodeRef.current) {
      try { gainNodeRef.current.disconnect(); } catch { /* */ }
      gainNodeRef.current = null;
    }

    // Cancel reader (closes the HTTP connection)
    if (readerRef.current) {
      readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Resume context if it was suspended to avoid blocking other audio
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    setIsPlaying(false);
    setIsPaused(false);
  }, []);

  // Pause playback — suspends AudioContext, keeps HTTP connection alive
  const pause = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'running') {
      ctx.suspend();
      setIsPaused(true);
    }
  }, []);

  // Resume playback — resumes AudioContext after pause
  const resume = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
      setIsPaused(false);
    }
  }, []);

  // Pre-unlock audio for mobile Safari
  // This must be called within a user gesture context
  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      // Get or create AudioContext
      const ctx = getAudioContext();
      
      // Resume if suspended (required for iOS Safari)
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a tiny silent buffer to fully unlock
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      
      console.log('[useServerTTS] Audio unlocked for mobile playback');
    } catch (err) {
      console.error('[useServerTTS] Failed to unlock audio:', err);
    }
  }, []);

  // Speak text using server TTS
  const speak = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    // Stop any existing playback
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);
    playbackEndedRef.current = false;

    try {
      // Unlock audio context first (required for mobile Safari)
      // Must be done before any async operations to stay within user gesture context
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a silent buffer to fully unlock audio on iOS
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);

      // Create abort controller for this request
      abortControllerRef.current = new AbortController();

      // Apply volume via GainNode
      const volume = options?.volume ?? 1.0;
      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;
      gainNode.connect(ctx.destination);
      gainNodeRef.current = gainNode;

      const voice = options?.voice || 'nova';
      console.log('[useServerTTS] Speaking with voice:', voice, 'options:', options);

      // Fetch audio from server
      const response = await runtimeFetch('/api/tts/speak', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          voice,
          model: options?.model || undefined,
          speed: options?.speed || 0.9,
          instructions: options?.instructions,
          summarize: false,
          // Use provided provider/model, or fall back to current chat model
          providerId: options?.providerId || currentProviderId || undefined,
          modelId: options?.modelId || currentModelId || undefined,
          // Send API key from settings if available
          apiKey: options?.baseURL ? (openaiCompatibleApiKey || undefined) : (openaiApiKey || undefined),
          // Send custom base URL for OpenAI-compatible servers
          baseURL: options?.baseURL || undefined,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      // Start playback
      console.log('[useServerTTS] Starting audio playback via Web Audio API...');
      setIsPlaying(true);
      options?.onStart?.();

      // Check if response supports streaming
      if (!response.body) {
        // No streaming support — fallback to blob + decodeAudioData
        console.log('[useServerTTS] No streaming body, falling back to blob');
        const audioBlob = await response.blob();
        const arrayBuffer = await audioBlob.arrayBuffer();
        
        // Decode audio data using the same context we unlocked earlier
        console.log('[useServerTTS] Decoding audio data...');
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        
        // Create source node
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        // Apply pitch shift via detune (cents): 1200 cents = 1 octave
        const pitch = options?.pitch ?? 1.0;
        if (pitch !== 1.0) {
          source.detune.value = (pitch - 1.0) * 1200;
        }

        source.connect(gainNode);
        activeSourcesRef.current.push(source);
        
        // Set up event handlers
        source.onended = () => {
          console.log('[useServerTTS] Audio playback ended');
          setIsPlaying(false);
          options?.onEnd?.();
        };
        
        source.start(0);
        return;
      }

      // ── Streaming playback via ReadableStream ─────────────────────────────
      // For WAV format: parse header, then feed PCM chunks to AudioBufferSourceNodes.
      // For non-WAV (e.g. MP3): accumulate all chunks, then decode as blob fallback.
      const reader = response.body.getReader();
      readerRef.current = reader;

      let headerBuffer: Uint8Array = new Uint8Array(0);
      let wavInfo: WavInfo | null = null;
      let pcmAccumulator: Uint8Array = new Uint8Array(0);
      let isWav = false;
      let formatDetected = false;
      let nonWavBuffer: Uint8Array = new Uint8Array(0);

      nextStartTimeRef.current = ctx.currentTime + 0.05;

      // Flush accumulated PCM into an AudioBuffer and schedule it for playback
      const flushPcmBuffer = () => {
        if (pcmAccumulator.length === 0 || !wavInfo) return;
        
        const bytesPerSample = wavInfo.bitsPerSample / 8;
        const blockAlign = wavInfo.numChannels * bytesPerSample;
        const processableLength = pcmAccumulator.length - (pcmAccumulator.length % blockAlign);
        
        if (processableLength === 0) return;
        
        const chunkToProcess = pcmAccumulator.slice(0, processableLength);
        const audioBuffer = pcm16ToAudioBuffer(ctx, chunkToProcess, wavInfo);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        // Apply pitch shift via detune (cents): 1200 cents = 1 octave
        const pitch = options?.pitch ?? 1.0;
        if (pitch !== 1.0) {
          source.detune.value = (pitch - 1.0) * 1200;
        }

        source.connect(gainNode);
        activeSourcesRef.current.push(source);

        // Schedule back-to-back with previous chunk
        const startTime = Math.max(nextStartTimeRef.current, ctx.currentTime);
        source.start(startTime);
        nextStartTimeRef.current = startTime + audioBuffer.duration;
        
        // Keep remainder bytes for the next chunk
        pcmAccumulator = pcmAccumulator.slice(processableLength);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          if (!formatDetected) {
            // First chunk(s): detect audio format
            headerBuffer = concatUint8(headerBuffer, value);

            if (headerBuffer.length >= 4) {
              const riff = String.fromCharCode(
                headerBuffer[0], headerBuffer[1], headerBuffer[2], headerBuffer[3],
              );
              if (riff === 'RIFF') {
                // WAV format detected — wait for full header
                isWav = true;
                formatDetected = true;
                if (headerBuffer.length >= WAV_HEADER_SIZE) {
                  wavInfo = parseWavHeader(headerBuffer);
                  const pcm = headerBuffer.slice(WAV_HEADER_SIZE);
                  headerBuffer = new Uint8Array(0);
                  if (pcm.length > 0) {
                    pcmAccumulator = concatUint8(pcmAccumulator, pcm);
                  }
                }
              } else {
                // Not WAV — accumulate for blob fallback
                console.log('[useServerTTS] Non-WAV format, accumulating for blob fallback');
                formatDetected = true;
                nonWavBuffer = headerBuffer;
                headerBuffer = new Uint8Array(0);
              }
            }
            continue;
          }

          if (isWav && wavInfo) {
            // Progressive WAV playback: accumulate PCM, flush when enough data
            pcmAccumulator = concatUint8(pcmAccumulator, value);
            if (pcmAccumulator.length >= MIN_PCM_CHUNK_BYTES) {
              flushPcmBuffer();
            }
          } else {
            // Non-WAV: accumulate for blob fallback
            nonWavBuffer = concatUint8(nonWavBuffer, value);
          }
        }

        // Flush any remaining PCM data
        if (isWav && wavInfo) {
          flushPcmBuffer();
          // Set up event handler on the last source to detect playback end
          const lastSource = activeSourcesRef.current[activeSourcesRef.current.length - 1];
          if (lastSource) {
            lastSource.onended = () => {
              if (!playbackEndedRef.current) {
                console.log('[useServerTTS] Audio playback ended');
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

          // Apply pitch shift via detune (cents): 1200 cents = 1 octave
          const pitch = options?.pitch ?? 1.0;
          if (pitch !== 1.0) {
            source.detune.value = (pitch - 1.0) * 1200;
          }

          source.connect(gainNode);
          activeSourcesRef.current.push(source);

          // Set up event handlers
          source.onended = () => {
            if (!playbackEndedRef.current) {
              console.log('[useServerTTS] Audio playback ended');
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
      if ((err as Error).name === 'AbortError') {
        // Request was aborted, don't show error
        return;
      }
      
      const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
      console.error('[useServerTTS] Error:', errorMsg);
      setError(errorMsg);
      options?.onError?.(errorMsg);
      setIsPlaying(false);
    }
  }, [stop, currentProviderId, currentModelId, openaiApiKey, openaiCompatibleApiKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
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
