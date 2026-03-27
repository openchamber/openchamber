/**
 * useSayTTS Hook
 * 
 * React hook for macOS 'say' command text-to-speech playback.
 * Uses the native macOS speech synthesis via server API.
 * Uses Web Audio API for playback (better iOS Safari support).
 * 
 * @example
 * ```typescript
 * const { speak, isPlaying, stop, isAvailable } = useSayTTS();
 * 
 * // Speak text
 * await speak('Hello, this is a test');
 * 
 * // Stop playback
 * stop();
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
      const response = await fetch('/api/tts/say/status');
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
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Whether the macOS say command is available */
  isAvailable: boolean;
  /** Available voices */
  voices: Array<{ name: string; locale: string }>;
  /** Current error if any */
  error: string | null;
  /** Speak the given text */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** Stop current playback */
  stop: () => void;
  /** Check if service is available */
  checkAvailability: () => Promise<boolean>;
  /** Unlock audio for mobile Safari - call this on user gesture */
  unlockAudio: () => Promise<void>;
}

export interface SpeakOptions {
  /** Voice to use (defaults to Samantha) */
  voice?: string;
  /** Speech rate in words per minute (defaults to 200) */
  rate?: number;
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

export function useSayTTS(options: UseSayTTSOptions = {}): UseSayTTSReturn {
  const enabled = options.enabled ?? true;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [voices, setVoices] = useState<Array<{ name: string; locale: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Unlock audio for mobile Safari - must be called within user gesture
  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      // Get or create AudioContext
      const ctx = getAudioContext();
      
      // Resume if suspended (required for iOS Safari)
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useSayTTS] AudioContext resumed');
      }
      
      // Play a tiny silent buffer to fully unlock
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

  // Check if macOS say is available
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

  // Check availability on mount
  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // Stop current playback
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

  // Speak text using macOS say
  const speak = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    // Stop any existing playback
    stop();
    
    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);
    
    try {
      // Create abort controller for this request
      abortControllerRef.current = new AbortController();
      
      // Fetch audio from server
      const response = await fetch('/api/tts/say/speak', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          voice: options?.voice || 'Samantha',
          rate: options?.rate || 200,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      // Get audio data from response
      const audioBlob = await response.blob();
      const arrayBuffer = await audioBlob.arrayBuffer();
      console.log('[useSayTTS] Received audio:', audioBlob.size, 'bytes');
      
      // Use Web Audio API for playback (same as useServerTTS)
      const ctx = getAudioContext();
      
      // Resume context if suspended
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useSayTTS] AudioContext resumed before playback');
      }
      
      // Decode audio data
      console.log('[useSayTTS] Decoding audio data...');
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      
      // Create source node
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      audioSourceRef.current = source;
      
      // Set up event handlers
      source.onended = () => {
        console.log('[useSayTTS] Audio playback ended');
        setIsPlaying(false);
        audioSourceRef.current = null;
        options?.onEnd?.();
      };
      
      // Start playback
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

  // Cleanup on unmount
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
