
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { ReadingPlayback } from '@/lib/voice/readingAudioFocus';

interface SayTTSStatusCache {
  available: boolean;
  voices: Array<{ name: string; locale: string }>;
  checkedAt: number;
}

interface UseSayTTSOptions {
  enabled?: boolean;
}

const SAY_TTS_STATUS_TTL_MS = 30000;
let sayTTSStatusCache: SayTTSStatusCache | null = null;
let sayTTSStatusRequest: Promise<SayTTSStatusCache> | null = null;

async function getSayTTSStatus(): Promise<SayTTSStatusCache> {
  const now = Date.now();
  if (sayTTSStatusCache && now - sayTTSStatusCache.checkedAt < SAY_TTS_STATUS_TTL_MS) {
    return sayTTSStatusCache;
  }

  if (sayTTSStatusRequest) {
    return sayTTSStatusRequest;
  }

  sayTTSStatusRequest = (async () => {
    try {
      const response = await runtimeFetch('/api/tts/say/status');
      if (!response.ok) {
        const unavailableStatus: SayTTSStatusCache = {
          available: false,
          voices: [],
          checkedAt: Date.now(),
        };
        sayTTSStatusCache = unavailableStatus;
        return unavailableStatus;
      }

      const data = await response.json();
      const nextStatus: SayTTSStatusCache = {
        available: Boolean(data.available),
        voices: Array.isArray(data.voices) ? data.voices : [],
        checkedAt: Date.now(),
      };
      sayTTSStatusCache = nextStatus;
      return nextStatus;
    } catch {
      const unavailableStatus: SayTTSStatusCache = {
        available: false,
        voices: [],
        checkedAt: Date.now(),
      };
      sayTTSStatusCache = unavailableStatus;
      return unavailableStatus;
    } finally {
      sayTTSStatusRequest = null;
    }
  })();

  return sayTTSStatusRequest;
}

export interface UseSayTTSReturn {
  isPlaying: boolean;
  isAvailable: boolean;
  voices: Array<{ name: string; locale: string }>;
  error: string | null;
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  stop: () => void;
  checkAvailability: () => Promise<boolean>;
  unlockAudio: () => Promise<void>;
}

interface SpeakOptions {
  beforePlayback?: (playback: ReadingPlayback) => Promise<void>;
  voice?: string;
  rate?: number;
  language?: 'auto';
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

export function useSayTTS(options: UseSayTTSOptions = {}): UseSayTTSReturn {
  const enabled = options.enabled ?? true;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [voices, setVoices] = useState<Array<{ name: string; locale: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      const ctx = getAudioContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useSayTTS] AudioContext resumed');
      }

      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);

      console.log('[useSayTTS] Audio unlocked for mobile playback');
    } catch (err) {
      console.error('[useSayTTS] Failed to unlock audio:', err);
    }
  }, []);

  const checkAvailability = useCallback(async (): Promise<boolean> => {
    if (!enabled) {
      setIsAvailable(false);
      setVoices([]);
      return false;
    }

    try {
      const status = await getSayTTSStatus();
      setIsAvailable(status.available);
      setVoices(status.voices);
      return status.available;
    } catch {
      setIsAvailable(false);
      setVoices([]);
      return false;
    }
  }, [enabled]);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  const stop = useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      audioSourceRef.current = null;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setIsPlaying(false);
  }, []);

  const speak = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);

    try {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const response = await runtimeFetch('/api/tts/say/speak', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          voice: options?.voice || 'Samantha',
          rate: options?.rate || 200,
          language: options?.language,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const audioBlob = await response.blob();
      const arrayBuffer = await audioBlob.arrayBuffer();
      console.log('[useSayTTS] Received audio:', audioBlob.size, 'bytes');

      const ctx = getAudioContext();

      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useSayTTS] AudioContext resumed before playback');
      }

      console.log('[useSayTTS] Decoding audio data...');
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      await options?.beforePlayback?.({ pause: () => ctx.suspend(), resume: () => ctx.resume() });
      if (controller.signal.aborted) return;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      audioSourceRef.current = source;

      source.onended = () => {
        console.log('[useSayTTS] Audio playback ended');
        setIsPlaying(false);
        audioSourceRef.current = null;
        options?.onEnd?.();
      };

      console.log('[useSayTTS] Starting audio playback via Web Audio API...');
      setIsPlaying(true);
      options?.onStart?.();
      source.start(0);

    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return;
      }

      const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
      console.error('[useSayTTS] Error:', errorMsg);
      setError(errorMsg);
      options?.onError?.(errorMsg);
      setIsPlaying(false);
    }
  }, [stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    isAvailable,
    voices,
    error,
    speak,
    stop,
    checkAvailability,
    unlockAudio,
  };
}
