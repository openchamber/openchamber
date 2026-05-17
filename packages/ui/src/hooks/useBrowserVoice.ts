/**
 * useBrowserVoice Hook
 * 
 * React hook for browser-based voice chat integration.
 * Manages speech recognition, AI message sending, and speech synthesis.
 * 
 * @example
 * ```typescript
 * const {
 *   status,
 *   isSupported,
 *   language,
 *   setLanguage,
 *   startVoice,
 *   stopVoice,
 *   prepareVoice,
 *   isMobile,
 * } = useBrowserVoice();
 * 
 * // Start voice mode
 * startVoice();
 * 
 * // Change language
 * setLanguage('es-ES');
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { audioStreamService } from '@/lib/voice/audioStreamService';
import { wasmSttService } from '@/lib/voice/wasmSttService';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { useConfigStore } from '@/stores/useConfigStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { summarizeText, shouldSummarize, sanitizeForTTS } from '@/lib/voice/summarize';

export type BrowserVoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

export interface UseBrowserVoiceReturn {
  /** Current voice status */
  status: BrowserVoiceStatus;
  /** Whether browser voice is supported */
  isSupported: boolean;
  /** Error message if any */
  error: string | null;
  /** Current language for recognition/synthesis */
  language: string;
  /** Set language for voice operations */
  setLanguage: (lang: string) => void;
  /** Start voice mode (listening) */
  startVoice: () => void;
  /** Stop voice mode */
  stopVoice: () => void;
  /** Finish current voice input and process it */
  finishVoiceInput: () => void;
  /** Whether conversation mode is active */
  conversationMode: boolean;
  /** Toggle conversation mode */
  toggleConversationMode: () => void;
  /** Prepare voice for mobile (request permission) */
  prepareVoice: () => Promise<boolean>;
  /** Whether the device is mobile */
  isMobile: boolean;
  /** Current voice provider */
  voiceProvider: 'browser' | 'openai' | 'openai-compatible' | 'say';
}

// Storage key for persisting language preference
const LANGUAGE_STORAGE_KEY = 'browserVoiceLanguage';
// Storage key for persisting conversation mode preference
const CONVERSATION_MODE_STORAGE_KEY = 'browserVoiceConversationMode';
const LANGUAGE_CHANGE_EVENT = 'openchamber:voice-language-changed';
const CONVERSATION_MODE_CHANGE_EVENT = 'openchamber:voice-conversation-mode-changed';
const FINAL_TRANSCRIPT_SETTLE_MS = 1200;
const DEVICE_CHANGE_RESTART_DELAY_MS = 700;
const BLOCKED_SPEECH_LANGUAGES = new Set(['ru', 'ru-RU']);

const sanitizeSpeechLanguage = (lang: string): string => {
  const normalized = (lang || '').trim();
  if (!normalized) {
    return 'en-US';
  }
  const base = normalized.split('-')[0].toLowerCase();
  if (BLOCKED_SPEECH_LANGUAGES.has(normalized) || BLOCKED_SPEECH_LANGUAGES.has(base)) {
    return 'en-US';
  }
  return normalized;
};

/**
 * Hook for managing browser-based voice conversations
 */
export function useBrowserVoice(): UseBrowserVoiceReturn {
  const [status, setStatus] = useState<BrowserVoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguageState] = useState<string>(() => {
    // Try to load from localStorage, fallback to navigator.language
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved) return sanitizeSpeechLanguage(saved);
    }
    return sanitizeSpeechLanguage(navigator.language || 'en-US');
  });
  const [conversationMode, setConversationModeState] = useState<boolean>(() => {
    // Try to load from localStorage, default to false
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(CONVERSATION_MODE_STORAGE_KEY);
      return saved === 'true';
    }
    return false;
  });
  
  // Mobile detection
  const isMobile = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod|android|mobile|webos|blackberry|iemobile|opera mini/i.test(userAgent);
  }, []);
  
  // Refs for managing async operations
  const isActiveRef = useRef(false);
  const processingMessageRef = useRef(false);
  const lastTranscriptRef = useRef('');
  const pendingResumeOnVisibleRef = useRef(false);
  const pendingFinalTranscriptRef = useRef('');
  const finalTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceChangeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveRecoveryRetriesRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFinalizingRef = useRef(false);
  
  // Store access
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const sendMessage = useSessionUIStore((s) => s.sendMessage);
  const setPendingInputText = useInputStore((s) => s.setPendingInputText);
  const createSession = useSessionUIStore((s) => s.createSession);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const currentAgentName = useConfigStore((state) => state.currentAgentName);
  const voiceModeEnabled = useConfigStore((state) => state.voiceModeEnabled);
  const voiceProvider = useConfigStore((state) => state.voiceProvider);
  const speechRate = useConfigStore((state) => state.speechRate);
  const speechPitch = useConfigStore((state) => state.speechPitch);
  const speechVolume = useConfigStore((state) => state.speechVolume);
  const sayVoice = useConfigStore((state) => state.sayVoice);
  const browserVoice = useConfigStore((state) => state.browserVoice);
  const openaiVoice = useConfigStore((state) => state.openaiVoice);
  const openaiCompatibleVoice = useConfigStore((state) => state.openaiCompatibleVoice);
  const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);
  const openaiCompatibleTtsModel = useConfigStore((state) => state.openaiCompatibleTtsModel);
  const summarizeVoiceConversation = useConfigStore((state) => state.summarizeVoiceConversation);
  const summarizeCharacterThreshold = useConfigStore((state) => state.summarizeCharacterThreshold);

  const shouldCheckOpenAIAvailability = voiceModeEnabled && (voiceProvider === 'openai' || voiceProvider === 'openai-compatible');
  const shouldCheckSayAvailability = voiceModeEnabled && voiceProvider === 'say';

  // STT provider config
  const sttProvider = useConfigStore((state) => state.sttProvider);
  const sttServerUrl = useConfigStore((state) => state.sttServerUrl);
  const sttModel = useConfigStore((state) => state.sttModel);
  const wasmSttModel = useConfigStore((state) => state.wasmSttModel);
  const sttLanguage = useConfigStore((state) => state.sttLanguage);
  const sttSilenceThresholdDb = useConfigStore((state) => state.sttSilenceThresholdDb);
  const sttSilenceHoldMs = useConfigStore((state) => state.sttSilenceHoldMs);

  const isSupported = sttProvider === 'server'
    ? audioStreamService.isSupported()
    : sttProvider === 'wasm'
      ? wasmSttService.isSupported()
      : browserVoiceService.isSupported();

  // Server TTS for mobile (bypasses Safari audio restrictions)
  const { speak: speakServerTTS, stop: stopServerTTS, isAvailable: isServerTTSAvailable, unlockAudio: unlockServerTTSAudio } = useServerTTS({
    enabled: shouldCheckOpenAIAvailability,
    availabilityMode: voiceProvider === 'openai-compatible' ? 'openai-compatible' : 'openai',
  });

  // macOS Say TTS
  const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable, unlockAudio: unlockSayTTSAudio } = useSayTTS({
    enabled: shouldCheckSayAvailability,
  });
  
  // Stop voice when session changes to prevent microphone from staying active
  // This ensures voice mode doesn't carry over between sessions
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== currentSessionId) {
      // Session changed - stop any active voice session
      if (isActiveRef.current) {
        console.log('[useBrowserVoice] Session changed, stopping voice');
        isActiveRef.current = false;
        processingMessageRef.current = false;
        browserVoiceService.stopListening();
        audioStreamService.stopListening();
        browserVoiceService.cancelSpeech();
        setStatus('idle');
        setError(null);
      }
    }
    prevSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
  
  // Persist language preference
  const setLanguage = useCallback((lang: string) => {
    const nextLang = sanitizeSpeechLanguage(lang);
    setLanguageState(nextLang);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
      window.dispatchEvent(new CustomEvent<string>(LANGUAGE_CHANGE_EVENT, { detail: nextLang }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleLanguageEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      const nextLang = sanitizeSpeechLanguage(customEvent.detail || localStorage.getItem(LANGUAGE_STORAGE_KEY) || 'en-US');
      setLanguageState((prev) => (prev === nextLang ? prev : nextLang));
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY || !event.newValue) {
        return;
      }
      const nextLang = sanitizeSpeechLanguage(event.newValue);
      setLanguageState((prev) => (prev === nextLang ? prev : nextLang));
    };

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageEvent as EventListener);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageEvent as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // Toggle conversation mode
  const toggleConversationMode = useCallback(() => {
    setConversationModeState((prev) => {
      const next = !prev;
      browserVoiceService.setConversationMode(next);
      if (typeof window !== 'undefined') {
        localStorage.setItem(CONVERSATION_MODE_STORAGE_KEY, String(next));
        window.dispatchEvent(new CustomEvent<boolean>(CONVERSATION_MODE_CHANGE_EVENT, { detail: next }));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleConversationModeEvent = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>;
      const detail = customEvent.detail;
      if (typeof detail !== 'boolean') {
        return;
      }
      setConversationModeState((prev) => (prev === detail ? prev : detail));
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CONVERSATION_MODE_STORAGE_KEY || event.newValue == null) {
        return;
      }
      const next = event.newValue === 'true';
      setConversationModeState((prev) => (prev === next ? prev : next));
    };

    window.addEventListener(CONVERSATION_MODE_CHANGE_EVENT, handleConversationModeEvent as EventListener);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener(CONVERSATION_MODE_CHANGE_EVENT, handleConversationModeEvent as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // Initialize conversation mode in service on mount
  useEffect(() => {
    browserVoiceService.setConversationMode(conversationMode);
  }, [conversationMode]);
  
  // Refs for callbacks to avoid circular dependencies
  const handleSpeechErrorRef = useRef<((errorMsg: string) => void) | null>(null);
  const handleSpeechResultRef = useRef<((text: string, isFinal: boolean) => Promise<void>) | null>(null);

  // Start STT via the currently-selected provider.
  // Called by auto-recovery, restart-after-TTS, and visibility-resume paths.
  const startCurrentSTT = useCallback((lang: string) => {
    if (sttProvider === 'server') {
      void audioStreamService.startListening(lang, handleSpeechResultRef.current!, handleSpeechErrorRef.current!);
    } else if (sttProvider === 'wasm') {
      void wasmSttService.startListening(lang, handleSpeechResultRef.current!, handleSpeechErrorRef.current!);
    } else if (isMobile) {
      browserVoiceService.startListeningSync(lang, handleSpeechResultRef.current!, handleSpeechErrorRef.current!);
    } else {
      browserVoiceService.startListening(lang, handleSpeechResultRef.current!, handleSpeechErrorRef.current!);
    }
  }, [sttProvider, isMobile]);

  // Handle speech recognition error
  const handleSpeechError = useCallback((errorMsg: string) => {
    // Ignore errors if we've already stopped voice mode
    if (!isActiveRef.current) {
      console.log('[useBrowserVoice] Ignoring error after voice stopped:', errorMsg);
      return;
    }

    const normalizedError = errorMsg.toLowerCase();
    if (normalizedError.includes('aborted')) {
      console.log('[useBrowserVoice] Ignoring non-fatal aborted error');
      setError(null);
      setStatus('listening');
      return;
    }

    const isHidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    const isPermissionStyleError =
      normalizedError.includes('permission') ||
      normalizedError.includes('not allowed') ||
      normalizedError.includes('service not allowed');

    if (isHidden && isPermissionStyleError && conversationMode) {
      console.log('[useBrowserVoice] Suppressing permission error while app hidden; will resume on visibility');
      pendingResumeOnVisibleRef.current = true;
      setError(null);
      setStatus('idle');
      return;
    }

    // Network / server-unreachable errors: don't retry at all.
    // The user must fix connectivity and then manually restart voice.
    const isNetworkError =
      normalizedError.includes('network') ||
      normalizedError.includes('connection') ||
      normalizedError.includes('check connection');
    
    if (isNetworkError) {
      console.error('[useBrowserVoice] Network error — staying in error state:', errorMsg);
      setError(errorMsg);
      setStatus('error');
      consecutiveRecoveryRetriesRef.current = 0;
      if (recoveryTimerRef.current !== null) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      return;
    }
    
    console.error('[useBrowserVoice] Recognition error:', errorMsg);
    setError(errorMsg);
    setStatus('error');
    
    // Auto-recover from transient / non-permission errors with limited retries.
    // Skip recovery when finalising — the user explicitly stopped voice.
    if (isPermissionStyleError || isFinalizingRef.current) {
      consecutiveRecoveryRetriesRef.current = 0;
      return;
    }

    const nextRetry = consecutiveRecoveryRetriesRef.current + 1;
    consecutiveRecoveryRetriesRef.current = nextRetry;
    const MAX_RECOVERY_RETRIES = 3;

    if (nextRetry <= MAX_RECOVERY_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, nextRetry - 1), 8000);
      console.log(`[useBrowserVoice] Scheduling recovery retry ${nextRetry}/${MAX_RECOVERY_RETRIES} in ${delay}ms`);
      
      if (recoveryTimerRef.current !== null) {
        clearTimeout(recoveryTimerRef.current);
      }
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;
        if (!isActiveRef.current) return;
        setStatus('listening');
        setError(null);
        startCurrentSTT(language);
      }, delay);
    } else {
      console.log('[useBrowserVoice] Max recovery retries reached — staying in error state');
    }
  }, [language, conversationMode, startCurrentSTT]);

  // Update the ref when handleSpeechError changes
  useEffect(() => {
    handleSpeechErrorRef.current = handleSpeechError;
  }, [handleSpeechError]);

  const processFinalTranscript = useCallback(async (finalText: string) => {
    if (!finalText.trim() || !isActiveRef.current) return;

    // Prevent duplicate processing of same transcript
    if (finalText.trim() === lastTranscriptRef.current) return;
    lastTranscriptRef.current = finalText.trim();

    // Check if provider and model are configured
    if (!currentProviderId || !currentModelId) {
      setError('No provider or model configured. Please configure them in settings.');
      setStatus('error');
      return;
    }

    // Stop listening while processing
    browserVoiceService.stopListening();
    audioStreamService.stopListening();

    // Non-continuous mode: fill chat input only, do not auto-send.
    if (!conversationMode) {
      setPendingInputText(finalText.trim(), 'append-inline');
      processingMessageRef.current = false;
      isActiveRef.current = false;
      setStatus('idle');
      return;
    }

    setStatus('processing');
    processingMessageRef.current = true;

    try {
      // Create session if none exists
      let sessionId = currentSessionId;
      if (!sessionId) {
        console.log('[useBrowserVoice] No active session, creating new session...');
        const newSession = await createSession();
        if (!newSession) {
          setError('Failed to create session');
          setStatus('error');
          processingMessageRef.current = false;
          return;
        }
        sessionId = newSession.id;
        console.log('[useBrowserVoice] Created new session:', sessionId);
      }

      // Send message to AI
      await sendMessage(
        finalText.trim(),
        currentProviderId,
        currentModelId,
        currentAgentName ?? undefined
      );
      
      // Wait for AI response and speak it
      // We'll poll for new assistant messages
      const checkForResponse = async () => {
        if (!isActiveRef.current || !sessionId) return;

        const rawMessages = getSyncMessages(sessionId);
        const assistantMessages = rawMessages
          .filter(m => m.role === 'assistant')
          .sort((a, b) => {
            const aTime = (a as { time?: { created?: number } }).time?.created ?? 0;
            const bTime = (b as { time?: { created?: number } }).time?.created ?? 0;
            return bTime - aTime;
          });

        if (assistantMessages.length > 0) {
          const latestMessage = assistantMessages[0];
          const parts = getSyncParts(latestMessage.id);
          const textParts = parts
            .filter((p: { type: string; text?: string }) => p.type === 'text')
            .map((p: { type: string; text?: string }) => p.text ?? '')
            .join(' ');
          
          if (textParts.trim()) {
            // Speak the response
            setStatus('speaking');
            try {
              // Summarize text if enabled and over threshold
              let textToSpeak = textParts;
              if (summarizeVoiceConversation && shouldSummarize(textParts, 'voice')) {
                console.log('[useBrowserVoice] Summarizing AI response before speaking...');
                textToSpeak = await summarizeText(textParts, {
                  threshold: summarizeCharacterThreshold,
                });
              } else {
                // Still sanitize for TTS even when not summarizing
                textToSpeak = sanitizeForTTS(textParts);
              }
              
              // Helper to restart listening after speech ends
              // Only auto-restart if conversation mode is enabled
              const restartListening = () => {
                if (isActiveRef.current && conversationMode) {
                  const isHidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
                  if (isHidden) {
                    pendingResumeOnVisibleRef.current = true;
                    setStatus('idle');
                    return;
                  }

                  setStatus('listening');
                  startCurrentSTT(language);
                } else {
                  // In non-continuous mode, return to idle after AI responds
                  isActiveRef.current = false;
                  setStatus('idle');
                }
              };

              // Use server TTS when OpenAI (or OpenAI-compatible) provider is selected and available
              if ((voiceProvider === 'openai' || voiceProvider === 'openai-compatible') && isServerTTSAvailable) {
                const ttsVoice = voiceProvider === 'openai-compatible' ? openaiCompatibleVoice : openaiVoice;
                const ttsBaseURL = voiceProvider === 'openai-compatible' ? openaiCompatibleUrl : undefined;
                const ttsModel = voiceProvider === 'openai-compatible' ? openaiCompatibleTtsModel : undefined;
                console.log('[useBrowserVoice] Using server TTS with voice:', ttsVoice, 'provider:', voiceProvider);
                await speakServerTTS(textToSpeak, {
                  voice: ttsVoice,
                  model: ttsModel,
                  speed: speechRate,
                  pitch: speechPitch,
                  volume: speechVolume,
                  baseURL: ttsBaseURL,
                  onStart: () => console.log('[useBrowserVoice] Server TTS started'),
                  onEnd: () => {
                    console.log('[useBrowserVoice] Server TTS ended');
                    restartListening();
                  },
                  onError: (errorMsg) => {
                    console.error('[useBrowserVoice] Server TTS error:', errorMsg);
                    setError(`Voice TTS failed: ${errorMsg}. Please check your settings or switch to Browser voice.`);
                    setStatus('error');
                    restartListening();
                  }
                });
              } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                // Use macOS 'say' command
                console.log('[useBrowserVoice] Using macOS Say TTS with voice:', sayVoice);
                // Convert speechRate (0.5-2.0) to words per minute (100-400)
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(textToSpeak, {
                  voice: sayVoice,
                  rate: wordsPerMinute,
                  onStart: () => console.log('[useBrowserVoice] Say TTS started'),
                  onEnd: () => {
                    console.log('[useBrowserVoice] Say TTS ended');
                    restartListening();
                  },
                  onError: (errorMsg) => {
                    console.error('[useBrowserVoice] Say TTS error:', errorMsg);
                    restartListening();
                  }
                });
              } else {
                // Use browser TTS (desktop and mobile)
                // Pre-load voices and unlock audio context before speaking
                console.log('[useBrowserVoice] Using browser TTS');
                
                // Warn user if they selected OpenAI but it's unavailable
                if (voiceProvider === 'openai' && !isServerTTSAvailable) {
                  console.warn('[useBrowserVoice] OpenAI voice selected but unavailable, falling back to browser voice');
                  setError('OpenAI voice unavailable (API key not configured). Using browser voice instead.');
                }
                
                await browserVoiceService.waitForVoices();
                await browserVoiceService.resumeAudioContext();
                
                await browserVoiceService.speakText(textToSpeak, language, () => {
                  // When speech ends, go back to listening if still active
                  restartListening();
                }, { rate: speechRate, pitch: speechPitch, volume: speechVolume, voiceName: browserVoice || undefined });
              }
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : 'Speech failed';
              
              // Ignore errors if we've stopped voice (e.g., user cancelled during speech)
              if (!isActiveRef.current) {
                console.log('[useBrowserVoice] Ignoring speech error after voice stopped:', errorMsg);
                return;
              }
              
              console.error('[useBrowserVoice] Speech error:', errorMsg);
              
              // Check for autoplay policy error
              if (errorMsg.includes('not-allowed') || errorMsg.includes('autoplay')) {
                setError('Audio blocked by browser. Please click the voice button again to enable audio.');
              }
              
              // Only restart listening if conversation mode is enabled
              if (conversationMode) {
                setStatus('listening');
                startCurrentSTT(language);
              } else {
                // In non-continuous mode, return to idle after error
                isActiveRef.current = false;
                setStatus('idle');
              }
            }
            return;
          }
        }
        
        // Check again in 500ms
        setTimeout(checkForResponse, 500);
      };
      
      // Start checking for response after a short delay
      setTimeout(checkForResponse, 1000);
      
    } catch (err) {
      console.error('[useBrowserVoice] Send message error:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setStatus('error');
      processingMessageRef.current = false;
    }
  }, [currentSessionId, currentProviderId, currentModelId, currentAgentName, language, sendMessage, setPendingInputText, createSession, speechRate, speechPitch, speechVolume, isServerTTSAvailable, speakServerTTS, isSayTTSAvailable, speakSayTTS, voiceProvider, sayVoice, browserVoice, openaiVoice, openaiCompatibleVoice, openaiCompatibleUrl, openaiCompatibleTtsModel, summarizeVoiceConversation, summarizeCharacterThreshold, conversationMode, startCurrentSTT]);

  // Handle speech recognition result
  const handleSpeechResult = useCallback(async (text: string, isFinal: boolean) => {
    if (!isActiveRef.current) return;
    const normalized = text.trim();
    if (!isFinal || !normalized) return;

    console.log('[useBrowserVoice] Speech result:', normalized);
    pendingFinalTranscriptRef.current = normalized;

    if (finalTranscriptTimerRef.current) {
      clearTimeout(finalTranscriptTimerRef.current);
    }

    finalTranscriptTimerRef.current = setTimeout(() => {
      finalTranscriptTimerRef.current = null;
      const transcript = pendingFinalTranscriptRef.current.trim();
      pendingFinalTranscriptRef.current = '';
      if (!transcript) return;
      void processFinalTranscript(transcript);
    }, FINAL_TRANSCRIPT_SETTLE_MS);
  }, [processFinalTranscript]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (!pendingResumeOnVisibleRef.current) {
        return;
      }
      if (!isActiveRef.current || !conversationMode) {
        pendingResumeOnVisibleRef.current = false;
        return;
      }

      pendingResumeOnVisibleRef.current = false;
      setStatus('listening');
      try {
        startCurrentSTT(language);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to resume voice';
        setError(errorMsg);
        setStatus('error');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [conversationMode, isMobile, language, sttProvider, startCurrentSTT]);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') {
      return;
    }

    const handleDeviceChange = () => {
      if (!isActiveRef.current || status !== 'listening') {
        return;
      }

      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
      }

      deviceChangeRestartTimerRef.current = setTimeout(() => {
        deviceChangeRestartTimerRef.current = null;
        if (!isActiveRef.current || status !== 'listening') {
          return;
        }

        const isHidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
        if (isHidden) {
          pendingResumeOnVisibleRef.current = true;
          setStatus('idle');
          return;
        }

        try {
          browserVoiceService.stopListening();
          audioStreamService.stopListening();
          wasmSttService.stopListening();
          startCurrentSTT(language);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Microphone source changed. Tap mic to continue.';
          setError(errorMsg);
          setStatus('error');
          isActiveRef.current = false;
        }
      }, DEVICE_CHANGE_RESTART_DELAY_MS);
    };

    mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
        deviceChangeRestartTimerRef.current = null;
      }
    };
  }, [isMobile, language, status, sttProvider, startCurrentSTT]);

  // Update the ref when handleSpeechResult changes
  useEffect(() => {
    handleSpeechResultRef.current = handleSpeechResult;
  }, [handleSpeechResult]);

  // Prepare voice for mobile (request permission)
  const prepareVoice = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      return false;
    }
    if (sttProvider === 'server' || sttProvider === 'wasm') {
      // Permission is requested on startListening; nothing to pre-prepare
      return true;
    }
    try {
      await browserVoiceService.prepareListening();
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Microphone permission denied';
      setError(errorMsg);
      return false;
    }
  }, [isSupported, sttProvider]);

  // Start voice mode
  const startVoice = useCallback(async () => {
    if (!isSupported) {
      setError('Voice input not supported in this browser');
      setStatus('error');
      return;
    }
    
    if (!currentSessionId) {
      setError('No active session');
      setStatus('error');
      return;
    }
    
    isActiveRef.current = true;
    lastTranscriptRef.current = '';
    consecutiveRecoveryRetriesRef.current = 0;
    isFinalizingRef.current = false;
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    setError(null);
    setStatus('listening');

    if (sttProvider === 'server') {
      // Server STT: configure the service then start async recording
      audioStreamService.configure({
        baseURL: sttServerUrl,
        model: sttModel,
        language: sttLanguage || undefined,
        silenceThresholdDb: sttSilenceThresholdDb,
        silenceHoldMs: sttSilenceHoldMs,
      });
      try {
        await audioStreamService.startListening(language, handleSpeechResult, handleSpeechError);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Server STT start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
      }
      return;
    }

    if (sttProvider === 'wasm') {
      // WASM STT: ensure model is loaded then start recording
      const modelStatus = wasmSttService.getModelStatus();
      console.log('[useBrowserVoice] WASM model status:', modelStatus.state);
      if (modelStatus.state !== 'ready') {
        try {
          setStatus('processing');
          await wasmSttService.loadModel(wasmSttModel);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Failed to load Whisper model';
          console.error('[useBrowserVoice] WASM model load error:', errorMsg);
          setError(errorMsg);
          setStatus('error');
          isActiveRef.current = false;
          return;
        }
      }
      wasmSttService.configure({
        silenceThresholdDb: sttSilenceThresholdDb,
        silenceHoldMs: sttSilenceHoldMs,
      });
      try {
        await wasmSttService.startListening(language, handleSpeechResult, handleSpeechError);
        console.log('[useBrowserVoice] WASM listening started');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] WASM STT start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
      }
      return;
    }

    // Browser STT
    // On mobile, use sync path to ensure SpeechRecognition.start() is called
    // within the same user gesture context (required by iOS Safari)
    // Also unlock audio immediately for TTS playback later
    if (isMobile) {
      try {
        // Unlock audio context synchronously within user gesture
        browserVoiceService.unlockAudio().catch(() => {
          // Audio unlock failed, but continue anyway
        });
        // Also unlock server TTS audio for mobile Safari (OpenAI)
        unlockServerTTSAudio().catch(() => {
          // Server TTS unlock failed, but continue anyway
        });
        // Also unlock Say TTS audio for mobile Safari (macOS Say)
        unlockSayTTSAudio().catch(() => {
          // Say TTS unlock failed, but continue anyway
        });
        browserVoiceService.startListeningSync(language, handleSpeechResult, handleSpeechError);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Mobile voice start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
      }
    } else {
      // Desktop can use async path with permission check
      try {
        await browserVoiceService.startListening(language, handleSpeechResult, handleSpeechError);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to start voice';
        console.error('[useBrowserVoice] Desktop voice start error:', errorMsg);
        setError(errorMsg);
        setStatus('error');
        isActiveRef.current = false;
      }
    }
  }, [isSupported, currentSessionId, language, handleSpeechResult, handleSpeechError, isMobile, unlockServerTTSAudio, unlockSayTTSAudio, sttProvider, sttServerUrl, sttModel, wasmSttModel, sttLanguage, sttSilenceThresholdDb, sttSilenceHoldMs]);

  // Stop voice mode
  const stopVoice = useCallback(() => {
    isActiveRef.current = false;
    processingMessageRef.current = false;
    pendingResumeOnVisibleRef.current = false;
    consecutiveRecoveryRetriesRef.current = 0;
    isFinalizingRef.current = false;
    if (deviceChangeRestartTimerRef.current) {
      clearTimeout(deviceChangeRestartTimerRef.current);
      deviceChangeRestartTimerRef.current = null;
    }
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    pendingFinalTranscriptRef.current = '';
    if (finalTranscriptTimerRef.current) {
      clearTimeout(finalTranscriptTimerRef.current);
      finalTranscriptTimerRef.current = null;
    }
    browserVoiceService.stopListening();
    audioStreamService.stopListening();
    wasmSttService.stopListening();
    browserVoiceService.cancelSpeech();
    stopServerTTS(); // Also stop server TTS if playing
    stopSayTTS(); // Also stop Say TTS if playing
    setStatus('idle');
    setError(null);
  }, [stopServerTTS, stopSayTTS]);

  const finishVoiceInput = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }

    isFinalizingRef.current = true;
    pendingResumeOnVisibleRef.current = false;
    if (deviceChangeRestartTimerRef.current) {
      clearTimeout(deviceChangeRestartTimerRef.current);
      deviceChangeRestartTimerRef.current = null;
    }
    setStatus('processing');

    if (sttProvider === 'server') {
      void audioStreamService.finishListening().then(() => {
        window.setTimeout(() => {
          if (!isActiveRef.current) {
            return;
          }
          if (pendingFinalTranscriptRef.current || finalTranscriptTimerRef.current) {
            return;
          }
          if (processingMessageRef.current) {
            return;
          }
          isActiveRef.current = false;
          processingMessageRef.current = false;
          setStatus('idle');
        }, FINAL_TRANSCRIPT_SETTLE_MS + 200);
      });
      return;
    }

    if (sttProvider === 'wasm') {
      // Inference runs in a Web Worker — no main-thread freeze.
      void wasmSttService.finishListening().then(() => {
        window.setTimeout(() => {
          if (!isActiveRef.current) {
            return;
          }
          if (pendingFinalTranscriptRef.current || finalTranscriptTimerRef.current) {
            return;
          }
          if (processingMessageRef.current) {
            return;
          }
          isActiveRef.current = false;
          processingMessageRef.current = false;
          setStatus('idle');
          isFinalizingRef.current = false;
        }, FINAL_TRANSCRIPT_SETTLE_MS + 200);
      });
      return;
    }

    browserVoiceService.stopListening();
    window.setTimeout(() => {
      if (!isActiveRef.current) {
        return;
      }
      if (pendingFinalTranscriptRef.current || finalTranscriptTimerRef.current) {
        return;
      }
      if (processingMessageRef.current) {
        return;
      }
      isActiveRef.current = false;
      processingMessageRef.current = false;
      setStatus('idle');
    }, FINAL_TRANSCRIPT_SETTLE_MS + 300);
  }, [sttProvider]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (deviceChangeRestartTimerRef.current) {
        clearTimeout(deviceChangeRestartTimerRef.current);
        deviceChangeRestartTimerRef.current = null;
      }
      pendingFinalTranscriptRef.current = '';
      if (finalTranscriptTimerRef.current) {
        clearTimeout(finalTranscriptTimerRef.current);
        finalTranscriptTimerRef.current = null;
      }
      browserVoiceService.setConversationMode(false);
      browserVoiceService.stopListening();
      audioStreamService.stopListening();
      browserVoiceService.cancelSpeech();
    };
  }, []);
  
  return {
    status,
    isSupported,
    error,
    language,
    setLanguage,
    startVoice,
    stopVoice,
    finishVoiceInput,
    conversationMode,
    toggleConversationMode,
    prepareVoice,
    isMobile,
    voiceProvider,
  };
}
