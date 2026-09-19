/**
 * useServerTTS Hook
 * 
 * React hook for server-side text-to-speech playback.
 * Fetches audio from the server and plays it, bypassing mobile Safari restrictions.
 * 
 * @example
 * ```typescript
 * const { speak, isPlaying, stop, isAvailable } = useServerTTS();
 * 
 * // Speak text
 * await speak('Hello, this is a test');
 * 
 * // Stop playback
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
  if (
    serverTTSStatusCache &&
    now - serverTTSStatusCache.checkedAt < SERVER_TTS_STATUS_TTL_MS
  ) {
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

export interface UseServerTTSReturn {
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Whether the server TTS service is available */
  isAvailable: boolean;
  /** Current error if any */
  error: string | null;
  /** Speak the given text */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** Stop current playback */
  stop: () => void;
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
    sharedAudioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
  }
  return sharedAudioContext;
}

/** Minimum characters for a standalone TTS chunk; shorter fragments (abbreviations, initials) merge into neighbors. */
const TTS_MIN_CHUNK_LENGTH = 40;
/** Texts at or below this length skip sentence splitting and use the single-request fast path. */
const TTS_FAST_PATH_MAX_LENGTH = 200;

function segmentSentences(text: string): string[] {
  const Segmenter = globalThis.Intl?.Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'sentence' }).segment(text),
      (segment) => segment.segment,
    );
  }
  // Fallback for browsers without Intl.Segmenter. Built via new RegExp inside
  // try/catch because a lookbehind literal is a parse-time SyntaxError on WebKit
  // without lookbehind support (Safari < 16.4) and would break the whole bundle.
  try {
    return text.split(new RegExp('(?<=[.!?…])\\s+'));
  } catch {
    return [text];
  }
}

/**
 * Split text into sentence-level TTS chunks. Short fragments left over after
 * abbreviation splits (т.д., т.е., initials) are merged with adjacent chunks so
 * every request carries a meaningful piece of speech.
 */
export function splitSentencesForTTS(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= TTS_FAST_PATH_MAX_LENGTH) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let pending = '';
  for (const segment of segmentSentences(trimmed)) {
    pending += segment;
    if (pending.trim().length >= TTS_MIN_CHUNK_LENGTH) {
      chunks.push(pending.trim());
      pending = '';
    }
  }
  const tail = pending.trim();
  if (tail) {
    if (tail.length < TTS_MIN_CHUNK_LENGTH && chunks.length > 0) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`;
    } else {
      chunks.push(tail);
    }
  }
  return chunks;
}

interface TTSRequestConfig {
  currentProviderId: string;
  currentModelId: string;
  openaiApiKey: string;
  openaiCompatibleApiKey: string;
}

function buildTTSRequestBody(
  text: string,
  options: SpeakOptions | undefined,
  config: TTSRequestConfig,
) {
  return {
    text,
    voice: options?.voice || 'nova',
    model: options?.model || undefined,
    speed: options?.speed || 0.9,
    instructions: options?.instructions,
    summarize: false,
    // Use provided provider/model, or fall back to current chat model
    providerId: options?.providerId || config.currentProviderId || undefined,
    modelId: options?.modelId || config.currentModelId || undefined,
    // Send API key from settings if available
    apiKey: options?.baseURL
      ? config.openaiCompatibleApiKey || undefined
      : config.openaiApiKey || undefined,
    // Send custom base URL for OpenAI-compatible servers
    baseURL: options?.baseURL || undefined,
  };
}

async function fetchTTSAudioChunk(
  ctx: AudioContext,
  text: string,
  options: SpeakOptions | undefined,
  config: TTSRequestConfig,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  const response = await runtimeFetch('/api/tts/speak', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildTTSRequestBody(text, options, config)),
    signal,
  });

  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  const audioBlob = await response.blob();
  const arrayBuffer = await audioBlob.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

/** Schedule an audio chunk and return its source and the time it finishes playing. */
function scheduleAudioChunk(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  options: SpeakOptions | undefined,
  startAt: number,
) {
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  // Apply pitch shift via detune (cents): 1200 cents = 1 octave
  const pitch = options?.pitch ?? 1.0;
  const detuneCents = pitch !== 1.0 ? (pitch - 1.0) * 1200 : 0;
  if (detuneCents !== 0) {
    source.detune.value = detuneCents;
  }

  // Apply volume via GainNode
  const gainNode = ctx.createGain();
  gainNode.gain.value = options?.volume ?? 1.0;

  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(startAt);

  // Detune shifts playback rate (one octave = 2x), changing real playback duration.
  return {
    source,
    endsAt: startAt + audioBuffer.duration / 2 ** (detuneCents / 1200),
  };
}

/** Outcome of the chunked synthesis loop. */
export type ChunkedPlaybackResult =
  | { status: 'completed'; scheduled: number }
  | { status: 'aborted'; scheduled: number }
  | { status: 'all-failed' };

/**
 * Synthesize and schedule sentence chunks in order: each chunk is fetched,
 * scheduled for playback as soon as it is decoded, and the next chunk is
 * fetched while the current one plays. Completion is reported through
 * onAllEnded once every scheduled chunk has ended (or earlier chunks ended
 * and every remaining fetch failed). Test hooks are injected as deps so the
 * scheduling and failure behavior is unit-testable without Web Audio.
 */
export async function runChunkedTTSPlayback<TBuffer, TSource>(
  chunks: readonly string[],
  deps: {
    signal: AbortSignal;
    fetchChunk: (chunk: string) => Promise<TBuffer>;
    scheduleChunk: (
      audioBuffer: TBuffer,
      startAt: number,
    ) => { source: TSource; endsAt: number };
    currentTime: () => number;
    attachOnEnded: (source: TSource, handler: () => void) => void;
    onScheduled: (source: TSource) => void;
    onFirstScheduled: () => void;
    onAllEnded: () => void;
  },
): Promise<ChunkedPlaybackResult> {
  let scheduled = 0;
  let ended = 0;
  let fetchLoopDone = false;
  let finished = false;
  let nextStartTime = 0;

  // Completion is re-checked both when a chunk ends and when the fetch loop
  // finishes: the last scheduled chunk may already have ended while later
  // fetches were still in flight (and then failed).
  const maybeFinish = () => {
    if (
      fetchLoopDone &&
      !finished &&
      scheduled > 0 &&
      ended >= scheduled &&
      !deps.signal.aborted
    ) {
      finished = true;
      deps.onAllEnded();
    }
  };

  for (const chunk of chunks) {
    if (deps.signal.aborted) {
      break;
    }

    let audioBuffer: TBuffer;
    try {
      audioBuffer = await deps.fetchChunk(chunk);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        break;
      }
      // One failed sentence must not break the queue: skip it and continue.
      console.warn(
        '[useServerTTS] Skipping failed sentence chunk:',
        chunk,
        err,
      );
      continue;
    }
    if (deps.signal.aborted) {
      break;
    }

    const { source, endsAt } = deps.scheduleChunk(
      audioBuffer,
      Math.max(deps.currentTime(), nextStartTime),
    );
    nextStartTime = endsAt;
    deps.onScheduled(source);
    scheduled += 1;

    if (scheduled === 1) {
      deps.onFirstScheduled();
    }

    deps.attachOnEnded(source, () => {
      ended += 1;
      maybeFinish();
    });
  }

  fetchLoopDone = true;
  maybeFinish();

  if (deps.signal.aborted) {
    return { status: 'aborted', scheduled };
  }
  if (scheduled === 0) {
    return { status: 'all-failed' };
  }
  return { status: 'completed', scheduled };
}

export function useServerTTS(
  options: UseServerTTSOptions = {},
): UseServerTTSReturn {
  const enabled = options.enabled ?? true;
  const availabilityMode = options.availabilityMode ?? 'auto';
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Get current model and API settings from config store.
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const openaiApiKey = useConfigStore((state) => state.openaiApiKey);
  const openaiCompatibleUrl = useConfigStore(
    (state) => state.openaiCompatibleUrl,
  );
  const openaiCompatibleApiKey = useConfigStore(
    (state) => state.openaiCompatibleApiKey,
  );
  const ttsChunkedMode = useConfigStore((state) => state.ttsChunkedMode);

  // Check if server TTS is available
  const checkAvailability = useCallback(async (): Promise<boolean> => {
    if (!enabled) {
      setIsAvailable(false);
      return false;
    }

    const hasClientKey = Boolean(
      openaiApiKey && openaiApiKey.trim().length > 0,
    );
    const hasCustomUrl = Boolean(
      openaiCompatibleUrl && openaiCompatibleUrl.trim().length > 0,
    );
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
    // Stop Web Audio API sources (chunked playback may have several scheduled)
    for (const source of audioSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
    }
    audioSourcesRef.current = [];
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    setIsPlaying(false);
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
  const speak = useCallback(
    async (text: string, options?: SpeakOptions): Promise<void> => {
    // Stop any existing playback
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);

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
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const config = {
          currentProviderId,
          currentModelId,
          openaiApiKey,
          openaiCompatibleApiKey,
        };
        console.log(
          '[useServerTTS] Speaking with voice:',
          options?.voice || 'nova',
          'options:',
          options,
        );

        // Chunked (sentence-by-sentence) synthesis is a user setting; when disabled,
      // always take the single-request fast path.
      const chunks = ttsChunkedMode ? splitSentencesForTTS(text) : [text.trim()];

        if (chunks.length <= 1) {
          // Fast path: single request, single source — identical to non-chunked playback.
          const audioBuffer = await fetchTTSAudioChunk(
            ctx,
            chunks[0] ?? text.trim(),
            options,
            config,
            controller.signal,
          );
          const { source } = scheduleAudioChunk(ctx, audioBuffer, options, 0);

          audioSourcesRef.current = [source];
      
      // Set up event handlers
      source.onended = () => {
        console.log('[useServerTTS] Audio playback ended');
        setIsPlaying(false);
            audioSourcesRef.current = [];
        options?.onEnd?.();
      };
      
      // Start playback
          console.log(
            '[useServerTTS] Starting audio playback via Web Audio API...',
          );
      setIsPlaying(true);
      options?.onStart?.();
          return;
        }
      
        // Chunked pipeline: synthesize each sentence in order, schedule it as soon as
        // it is decoded, and fetch the next sentence while the current one plays.
        const sources: AudioBufferSourceNode[] = [];
        audioSourcesRef.current = sources;

        let onEndSent = false;
        const sendOnEnd = () => {
          if (!onEndSent) {
            onEndSent = true;
            options?.onEnd?.();
          }
        };

        const result = await runChunkedTTSPlayback(chunks, {
          signal: controller.signal,
          fetchChunk: (chunk) =>
            fetchTTSAudioChunk(ctx, chunk, options, config, controller.signal),
          scheduleChunk: (audioBuffer, startAt) =>
            scheduleAudioChunk(ctx, audioBuffer, options, startAt),
          currentTime: () => ctx.currentTime,
          attachOnEnded: (source, handler) => {
            source.onended = handler;
          },
          onScheduled: (source) => {
            sources.push(source);
          },
          onFirstScheduled: () => {
            console.log(
              '[useServerTTS] Starting chunked audio playback via Web Audio API...',
            );
            setIsPlaying(true);
            options?.onStart?.();
          },
          onAllEnded: () => {
            console.log('[useServerTTS] Chunked playback finished');
            setIsPlaying(false);
            audioSourcesRef.current = [];
            sendOnEnd();
          },
        });

        if (result.status === 'aborted') {
          // Mirror the single-request path, where stopping playback fires onended -> onEnd.
          if (result.scheduled > 0) {
            sendOnEnd();
          }
          return;
        }

        if (result.status === 'all-failed') {
          // Every chunk failed: surface the error like the single-request path does.
          const errorMsg = 'Failed to speak: all sentence chunks failed';
          console.error('[useServerTTS] Error:', errorMsg);
          setError(errorMsg);
          options?.onError?.(errorMsg);
          setIsPlaying(false);
          return;
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
    },
    [
      stop,
      currentProviderId,
      currentModelId,
      openaiApiKey,
      openaiCompatibleApiKey,
      ttsChunkedMode,
    ],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    isAvailable,
    error,
    speak,
    stop,
    checkAvailability,
    unlockAudio,
  };
}
