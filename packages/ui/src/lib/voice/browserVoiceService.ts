/**
 * Browser Voice Service - Web Speech API wrapper
 * 
 * Provides speech recognition (STT) and speech synthesis (TTS) using
 * browser-native Web Speech API. No external dependencies required.
 * 
 * @example
 * ```typescript
 * import { browserVoiceService } from './browserVoiceService';
 * 
 * // Check support
 * if (browserVoiceService.isSupported()) {
 *   // Start listening
 *   browserVoiceService.startListening('en-US', (text, isFinal) => {
 *     if (isFinal) {
 *       console.log('Final transcript:', text);
 *     }
 *   });
 *   
 *   // Speak text
 *   browserVoiceService.speakText('Hello world', 'en-US', () => {
 *     console.log('Speech finished');
 *   });
 * }
 * ```
 */

// Extend Window interface for SpeechRecognition
declare global {
  interface Window {
    SpeechRecognition: { new(): SpeechRecognition };
    webkitSpeechRecognition: { new(): SpeechRecognition };
  }
}

// Callback types
export type SpeechResultCallback = (text: string, isFinal: boolean) => void;
export type SpeechEndCallback = () => void;
export type ErrorCallback = (error: string) => void;

/**
 * Browser Voice Service class
 * Wraps Web Speech API with a clean interface
 */
class BrowserVoiceService {
  private recognition: SpeechRecognition | null = null;
  private isListening = false;
  private currentLang = 'en-US';
  private onResultCallback: SpeechResultCallback | null = null;
  private onErrorCallback: ErrorCallback | null = null;
  private restartOnEnd = false;
  private conversationMode = false;
  private isSpeaking = false;
  private audioContext: AudioContext | null = null;
  private audioUnlockRequired = false;

  /**
   * Check if browser supports Web Speech API
   */
  isSupported(): boolean {
    const hasRecognition = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    const hasSynthesis = 'speechSynthesis' in window;
    return hasRecognition && hasSynthesis;
  }

  /**
   * Get detailed support information
   */
  getSupportDetails(): {
    recognition: boolean;
    synthesis: boolean;
    prefixed: boolean;
    secureContext: boolean;
  } {
    return {
      recognition: 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window,
      synthesis: 'speechSynthesis' in window,
      prefixed: !('SpeechRecognition' in window) && 'webkitSpeechRecognition' in window,
      secureContext: window.isSecureContext,
    };
  }

  /**
   * Set conversation mode (continuous back-and-forth)
   * @param enabled - Whether to enable continuous conversation mode
   * 
   * Note: This only sets the flag - it does NOT auto-start listening.
   * The user must explicitly start voice mode first. Conversation mode
   * only affects whether listening auto-resumes after AI finishes speaking.
   */
  setConversationMode(enabled: boolean): void {
    this.conversationMode = enabled;
    // If disabling, stop auto-restart
    if (!enabled) {
      this.restartOnEnd = false;
    }
    // Note: We intentionally do NOT auto-start listening here.
    // The user must explicitly click the microphone button to start.
    // Conversation mode only controls auto-resume after speech ends.
  }

  /**
   * Check if conversation mode is active
   */
  isConversationMode(): boolean {
    return this.conversationMode;
  }

  /**
   * Pause listening temporarily (e.g., while AI is speaking)
   */
  pauseListening(): void {
    this.restartOnEnd = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore stop errors
      }
    }
    this.isListening = false;
  }

  /**
   * Resume listening after being paused
   */
  resumeListening(): void {
    console.log('[BrowserVoiceService] resumeListening called:', {
      conversationMode: this.conversationMode,
      hasCallback: !!this.onResultCallback,
      isSpeaking: this.isSpeaking,
      currentLang: this.currentLang
    });
    
    if (this.conversationMode && this.onResultCallback && !this.isSpeaking) {
      // Use sync version for resume (should already have permission)
      try {
        console.log('[BrowserVoiceService] Resuming listening...');
        this.startListeningSync(this.currentLang, this.onResultCallback, this.onErrorCallback || undefined);
      } catch (err) {
        console.error('[BrowserVoiceService] Failed to resume listening:', err);
      }
    } else {
      console.log('[BrowserVoiceService] Not resuming - conditions not met');
    }
  }

  /**
   * Check if microphone permission is already granted
   * @returns Promise<boolean> - true if permission granted
   */
  async checkMicrophonePermission(): Promise<boolean> {
    try {
      if ('permissions' in navigator) {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return result.state === 'granted';
      }
      return false;
    } catch {
      // permissions API not supported or failed
      return false;
    }
  }

  /**
   * Prepare listening by requesting microphone permission
   * This should be called BEFORE user gesture on mobile to pre-request permission
   * @returns Promise<boolean> - true if permission granted
   */
  async prepareListening(): Promise<boolean> {
    if (!this.isSupported()) {
      throw new Error('Web Speech API not supported in this browser');
    }

    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      // Some embedded runtimes (e.g. desktop webviews) may not expose mediaDevices,
      // while SpeechRecognition can still request mic permission on start().
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err) {
      const name = typeof err === 'object' && err && 'name' in err ? String((err as { name?: unknown }).name) : '';
      if (name === 'NotAllowedError') {
        throw new Error('Microphone permission denied');
      }
      if (name === 'NotFoundError') {
        throw new Error('No microphone found');
      }
      const errorMsg = err instanceof Error ? err.message : 'Unable to access microphone';
      throw new Error(errorMsg);
    }
  }

  /**
   * Start speech recognition SYNCHRONOUSLY
   * Must be called within a user gesture handler on mobile (iOS Safari)
   * @param lang - BCP 47 language tag (e.g., 'en-US', 'es-ES')
   * @param onResult - Callback for speech results
   * @param onError - Optional callback for errors
   */
  startListeningSync(
    lang: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback
  ): void {
    if (!this.isSupported()) {
      const errorMsg = 'Web Speech API not supported in this browser';
      onError?.(errorMsg);
      throw new Error(errorMsg);
    }

    // Stop any existing recognition
    this.stopListening();

    // Create new recognition instance
    const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognitionConstructor();
    this.currentLang = lang;
    this.onResultCallback = onResult;
    this.onErrorCallback = onError || null;

    // Configure recognition
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = lang;

    // Set up event handlers
    this.recognition.onstart = () => {
      console.log('[BrowserVoiceService] Recognition started');
      this.isListening = true;
      this.restartOnEnd = true;
    };
    
    this.recognition.onaudiostart = () => {
      console.log('[BrowserVoiceService] Audio recording started');
    };
    
    this.recognition.onsoundstart = () => {
      console.log('[BrowserVoiceService] Sound detected');
    };

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      console.log('[BrowserVoiceService] Got result:', event.results.length, 'results');
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      console.log('[BrowserVoiceService] Transcripts - interim:', interimTranscript, 'final:', finalTranscript);

      // Send interim results
      if (interimTranscript) {
        console.log('[BrowserVoiceService] Calling onResultCallback with interim');
        this.onResultCallback?.(interimTranscript, false);
      }

      // Send final results
      if (finalTranscript) {
        console.log('[BrowserVoiceService] Calling onResultCallback with final');
        this.onResultCallback?.(finalTranscript, true);
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "aborted" is commonly emitted when we intentionally stop/pause recognition.
      // Treat it as non-fatal to avoid noisy error loops in continuous mode.
      if (event.error === 'aborted') {
        return;
      }

      const errorMessage = this.getErrorMessage(event.error);
      this.onErrorCallback?.(errorMessage);

      // Don't restart on fatal / unrecoverable errors.
      // "network" in Electron/Chromium means Google's speech servers are unreachable;
      // auto-restarting immediately creates an infinite error → end → start → error loop.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'network') {
        this.restartOnEnd = false;
        this.isListening = false;
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      
      // Auto-restart if still supposed to be listening and not speaking.
      // Only restart when we have a valid recognition instance and restartOnEnd is set.
      if (this.restartOnEnd && this.recognition && !this.isSpeaking) {
        try {
          this.recognition.start();
        } catch {
          // Ignore restart errors — onerror / onend will fire if it's fatal.
        }
      }
    };

    // Start recognition - MUST be synchronous for iOS Safari
    try {
      this.recognition.start();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to start speech recognition';
      onError?.(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Start speech recognition (async version for desktop/backward compatibility)
   * @param lang - BCP 47 language tag (e.g., 'en-US', 'es-ES')
   * @param onResult - Callback for speech results
   * @param onError - Optional callback for errors
   * @returns Promise that resolves when recognition starts
   */
  async startListening(
    lang: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback
  ): Promise<void> {
    // Start recognition directly from the user gesture path.
    // Some webview runtimes reject preflight getUserMedia and then never show
    // permission prompt, while SpeechRecognition.start() can still trigger it.
    this.startListeningSync(lang, onResult, onError);
  }

  /**
   * Stop speech recognition
   */
  stopListening(): void {
    this.restartOnEnd = false;
    
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore stop errors
      }
      this.recognition = null;
    }
    
    this.isListening = false;
  }

  /**
   * Check if currently listening
   */
  getIsListening(): boolean {
    return this.isListening;
  }

  /**
   * Get current language
   */
  getCurrentLang(): string {
    return this.currentLang;
  }

  /**
   * Resume audio context to unlock audio for playback
   * Must be called within a user gesture handler
   */
  async resumeAudioContext(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Check if audio unlock is required (autoplay policy blocked audio)
   */
  isAudioUnlockRequired(): boolean {
    return this.audioUnlockRequired;
  }

  /**
   * Manually unlock audio by playing a silent sound
   * Call this from a button click handler for stubborn browsers
   */
  async unlockAudio(): Promise<boolean> {
    try {
      // Create and play silent audio to unlock Web Audio API
      const audio = new Audio();
      // 1ms silence WAV file (base64 encoded)
      audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      audio.volume = 0.01;
      await audio.play();

      // Resume audio context
      await this.resumeAudioContext();

      // Also unlock speech synthesis on mobile Safari by speaking a silent utterance
      // This must be done within a user gesture to allow future speech
      if (this.isMobileDevice() && 'speechSynthesis' in window) {
        const unlockUtterance = new SpeechSynthesisUtterance('');
        unlockUtterance.volume = 0;
        window.speechSynthesis.speak(unlockUtterance);
        window.speechSynthesis.cancel(); // Cancel immediately
        console.log('[BrowserVoiceService] Speech synthesis unlocked for mobile');
      }

      this.audioUnlockRequired = false;
      console.log('[BrowserVoiceService] Audio unlocked successfully');
      return true;
    } catch (err) {
      console.error('[BrowserVoiceService] Failed to unlock audio:', err);
      return false;
    }
  }

  /**
   * Speak text using speech synthesis
   * @param text - Text to speak
   * @param lang - BCP 47 language tag for voice selection
   * @param onEnd - Optional callback when speech ends
   * @param options - Optional TTS configuration (rate, pitch, volume, voiceName)
   * @returns Promise that resolves when speech starts
   */
  async speakText(
    text: string,
    lang: string,
    onEnd?: SpeechEndCallback,
    options?: { rate?: number; pitch?: number; volume?: number; voiceName?: string }
  ): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('Speech synthesis not supported');
    }

    // Resume audio context first (user gesture must have happened)
    await this.resumeAudioContext();

    // Wait for voices to be available (Chrome requires this)
    const voices = await this.waitForVoices();

    // Small delay to ensure audio context is ready
    await new Promise(resolve => setTimeout(resolve, 50));

    // Set speaking state and pause listening to avoid hearing ourselves
    this.isSpeaking = true;
    this.pauseListening();

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = options?.rate ?? 1;
    utterance.pitch = options?.pitch ?? 1;
    utterance.volume = options?.volume ?? 1;

    // Try to find voice by name first (user-selected), then fallback to language match
    let selectedVoice: SpeechSynthesisVoice | null = null;
    
    if (options?.voiceName) {
      selectedVoice = voices.find(v => v.name === options.voiceName) || null;
      if (selectedVoice) {
        console.log(`[BrowserVoiceService] Using selected voice: ${selectedVoice.name} (${selectedVoice.lang})`);
      } else {
        console.warn(`[BrowserVoiceService] Selected voice "${options.voiceName}" not found, falling back to language match`);
      }
    }
    
    if (!selectedVoice) {
      selectedVoice = this.findBestVoice(voices, lang);
      if (selectedVoice) {
        console.log(`[BrowserVoiceService] Using language-matched voice: ${selectedVoice.name} (${selectedVoice.lang})`);
      } else {
        console.warn(`[BrowserVoiceService] No voice found for language: ${lang}, using default`);
      }
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    console.log(`[BrowserVoiceService] Speaking text (${text.length} chars) in ${lang}`);

    return new Promise((resolve, reject) => {
      let hasStarted = false;

      utterance.onstart = () => {
        hasStarted = true;
        console.log('[BrowserVoiceService] Speech started');
        resolve();
      };

      utterance.onend = () => {
        this.isSpeaking = false;
        console.log('[BrowserVoiceService] Speech ended');
        onEnd?.();
      };

      utterance.onerror = (event) => {
        this.isSpeaking = false;
        console.error('[BrowserVoiceService] Speech synthesis error:', event.error);

        // Track autoplay policy violations
        if (event.error === 'not-allowed' || event.error === 'interrupted') {
          this.audioUnlockRequired = true;
        }

        // Provide more specific error messages
        let errorMessage = `Speech synthesis error: ${event.error || 'unknown'}`;
        if (event.error === 'not-allowed') {
          errorMessage = 'Audio blocked by browser autoplay policy. Please interact with the page first.';
        } else if (event.error === 'interrupted') {
          errorMessage = 'Speech was interrupted. Please try again.';
        }

        reject(new Error(errorMessage));
      };

      // Safety timeout - if onstart doesn't fire within 2 seconds, something is wrong
      setTimeout(() => {
        if (!hasStarted) {
          console.warn('[BrowserVoiceService] Speech start timeout - audio may be blocked');
          this.audioUnlockRequired = true;
        }
      }, 2000);

      window.speechSynthesis.speak(utterance);
    });
  }

  /**
   * Cancel ongoing speech
   */
  cancelSpeech(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  /**
   * Get available voices
   */
  getVoices(): SpeechSynthesisVoice[] {
    if (!('speechSynthesis' in window)) {
      return [];
    }
    return window.speechSynthesis.getVoices();
  }

  /**
   * Wait for voices to load (needed for Chrome)
   */
  async waitForVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!('speechSynthesis' in window)) {
      return [];
    }

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      return voices;
    }

    return new Promise((resolve) => {
      const handleVoicesChanged = () => {
        resolve(window.speechSynthesis.getVoices());
        window.speechSynthesis.onvoiceschanged = null;
      };
      
      window.speechSynthesis.onvoiceschanged = handleVoicesChanged;
      
      // Timeout fallback
      setTimeout(() => {
        resolve(window.speechSynthesis.getVoices());
        window.speechSynthesis.onvoiceschanged = null;
      }, 1000);
    });
  }

  /**
   * Find the best voice for a given language
   */
  private findBestVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
    // First try exact match
    let voice = voices.find(v => v.lang === lang);
    
    if (!voice) {
      // Try language code match (e.g., 'en' for 'en-US')
      const langCode = lang.split('-')[0];
      voice = voices.find(v => v.lang.startsWith(langCode));
    }
    
    if (!voice) {
      // Prefer local voices
      voice = voices.find(v => v.lang.startsWith(lang.split('-')[0]) && v.localService);
    }
    
    return voice || null;
  }

  /**
   * Check if running on mobile device
   */
  private isMobileDevice(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod|android|mobile|webos|blackberry|iemobile|opera mini/i.test(userAgent);
  }

  /**
   * Check if running on iOS Safari
   */
  private isIOSSafari(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/i.test(userAgent);
    const isSafari = /safari/i.test(userAgent) && !/chrome|crios|crmo/i.test(userAgent);
    return isIOS && isSafari;
  }

  /**
   * Get human-readable error message
   * @param error - Error code from SpeechRecognition
   */
  private getErrorMessage(error: string): string {
    const isMobileDevice = this.isMobileDevice();
    const isIOS = this.isIOSSafari();
    
    const errorMessages: Record<string, string> = {
      'no-speech': 'No speech detected',
      'aborted': 'Speech recognition aborted',
      'audio-capture': 'No microphone found',
      'network': 'Network error - check connection',
      'not-allowed': isMobileDevice 
        ? 'Microphone permission denied. Check Settings > Safari > Microphone' 
        : 'Microphone permission denied',
      'service-not-allowed': isIOS 
        ? 'Speech recognition requires a user gesture. Please tap the microphone button again.' 
        : 'Speech recognition service not allowed',
      'bad-grammar': 'Grammar error',
      'language-not-supported': 'Language not supported',
    };
    
    return errorMessages[error] || `Speech recognition error: ${error}`;
  }
}

// Export singleton instance
export const browserVoiceService = new BrowserVoiceService();

// Also export the class for testing/customization
export { BrowserVoiceService };
