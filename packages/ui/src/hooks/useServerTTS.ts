
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ReadingPlayback } from '@/lib/voice/readingAudioFocus';

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
  isPlaying: boolean;
  isAvailable: boolean;
  error: string | null;
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  stop: () => void;
  checkAvailability: () => Promise<boolean>;
  unlockAudio: () => Promise<void>;
}

interface SpeakOptions {
  beforePlayback?: (playback: ReadingPlayback) => Promise<void>;
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
  endpointPath?: string;
  keyProvider?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

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

const TTS_MIN_CHUNK_LENGTH = 40;
const TTS_FAST_PATH_MAX_LENGTH = 200;

function segmentSentences(text: string): string[] {
  const Segmenter = globalThis.Intl?.Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'sentence' }).segment(text),
      (segment) => segment.segment,
    );
  }
  try {
    return text.split(new RegExp('(?<=[.!?…])\\s+'));
  } catch {
    return [text];
  }
}

export function splitSentencesForTTS(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= TTS_FAST_PATH_MAX_LENGTH) {
    return [trimmed];
  }

  const chunks: string[] = [];
  for (const paragraph of trimmed.split(/\n+/)) {
    const line = paragraph.trim();
    if (!line) {
      continue;
    }
    const lineChunks: string[] = [];
    let pending = '';
    for (const segment of segmentSentences(line)) {
      pending += segment;
      if (pending.trim().length >= TTS_MIN_CHUNK_LENGTH) {
        lineChunks.push(pending.trim());
        pending = '';
      }
    }
    const tail = pending.trim();
    if (tail) {
      if (tail.length < TTS_MIN_CHUNK_LENGTH && lineChunks.length > 0) {
        lineChunks[lineChunks.length - 1] = `${lineChunks[lineChunks.length - 1]} ${tail}`;
      } else {
        lineChunks.push(tail);
      }
    }
    chunks.push(...lineChunks);
  }
  return chunks;
}

interface TTSRequestConfig {
  currentProviderId: string;
  currentModelId: string;
}

export function buildTTSRequestBody(
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
    providerId: options?.providerId || config.currentProviderId || undefined,
    modelId: options?.modelId || config.currentModelId || undefined,
    baseURL: options?.baseURL || undefined,
    endpointPath: options?.endpointPath || undefined,
    keyProvider: options?.keyProvider,
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

function scheduleAudioChunk(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  options: SpeakOptions | undefined,
  startAt: number,
) {
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const pitch = options?.pitch ?? 1.0;
  const detuneCents = pitch !== 1.0 ? (pitch - 1.0) * 1200 : 0;
  if (detuneCents !== 0) {
    source.detune.value = detuneCents;
  }

  const gainNode = ctx.createGain();
  gainNode.gain.value = options?.volume ?? 1.0;

  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(startAt);

  return {
    source,
    endsAt: startAt + audioBuffer.duration / 2 ** (detuneCents / 1200),
  };
}

export type ChunkedPlaybackResult =
  | { status: 'completed'; scheduled: number }
  | { status: 'aborted'; scheduled: number }
  | { status: 'all-failed' };

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
    beforePlayback?: () => Promise<void>;
  },
): Promise<ChunkedPlaybackResult> {
  let scheduled = 0;
  let ended = 0;
  let fetchLoopDone = false;
  let finished = false;
  let nextStartTime = 0;

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

    await deps.beforePlayback?.();
    if (deps.signal.aborted) break;
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

  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const hasStoredOpenaiKey = useConfigStore((state) => state.voiceApiKeys.openai);
  const refreshVoiceApiKeys = useConfigStore((state) => state.refreshVoiceApiKeys);
  const openaiCompatibleUrl = useConfigStore(
    (state) => state.openaiCompatibleUrl,
  );
  const ttsChunkedMode = useConfigStore((state) => state.ttsChunkedMode);

  const checkAvailability = useCallback(async (): Promise<boolean> => {
    if (!enabled) {
      setIsAvailable(false);
      return false;
    }

    const hasClientKey = hasStoredOpenaiKey;
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
  }, [availabilityMode, enabled, hasStoredOpenaiKey, openaiCompatibleUrl]);

  useEffect(() => {
    if (enabled) void refreshVoiceApiKeys();
  }, [enabled, refreshVoiceApiKeys]);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const stop = useCallback(() => {
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

  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      const ctx = getAudioContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }

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

  const speak = useCallback(
    async (text: string, options?: SpeakOptions): Promise<void> => {
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);

    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }

      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const config = {
          currentProviderId,
          currentModelId,
        };
        console.log(
          '[useServerTTS] Speaking with voice:',
          options?.voice || 'nova',
          'options:',
          options,
        );

      const chunks = ttsChunkedMode ? splitSentencesForTTS(text) : [text.trim()];

        if (chunks.length <= 1) {
          const audioBuffer = await fetchTTSAudioChunk(
            ctx,
            chunks[0] ?? text.trim(),
            options,
            config,
            controller.signal,
          );
          await options?.beforePlayback?.({ pause: () => ctx.suspend(), resume: () => ctx.resume() });
          if (controller.signal.aborted) return;
          const { source } = scheduleAudioChunk(ctx, audioBuffer, options, 0);

          audioSourcesRef.current = [source];

      source.onended = () => {
        console.log('[useServerTTS] Audio playback ended');
        setIsPlaying(false);
            audioSourcesRef.current = [];
        options?.onEnd?.();
      };

          console.log(
            '[useServerTTS] Starting audio playback via Web Audio API...',
          );
      setIsPlaying(true);
      options?.onStart?.();
          return;
        }

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
          beforePlayback: async () => options?.beforePlayback?.({ pause: () => ctx.suspend(), resume: () => ctx.resume() }),
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
          if (result.scheduled > 0) {
            sendOnEnd();
          }
          return;
        }

        if (result.status === 'all-failed') {
          const errorMsg = 'Failed to speak: all sentence chunks failed';
          console.error('[useServerTTS] Error:', errorMsg);
          setError(errorMsg);
          options?.onError?.(errorMsg);
          setIsPlaying(false);
          return;
        }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
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
      ttsChunkedMode,
    ],
  );

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
