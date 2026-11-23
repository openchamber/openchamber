
import type { ReadingPlayback } from './readingAudioFocus';

const isLinuxDesktopOs = (): boolean => navigator.platform.toLowerCase().startsWith('linux')
  && !/Android/i.test(navigator.userAgent);

declare global {
  interface Window {
    SpeechRecognition: { new(): SpeechRecognition };
    webkitSpeechRecognition: { new(): SpeechRecognition };
  }
}

type SpeechResultCallback = (text: string, isFinal: boolean) => void;
type SpeechEndCallback = () => void;
type ErrorCallback = (error: string) => void;

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

  isSupported(): boolean {
    const hasRecognition = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    const hasSynthesis = 'speechSynthesis' in window;
    return hasRecognition && hasSynthesis;
  }

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

  setConversationMode(enabled: boolean): void {
    this.conversationMode = enabled;
    if (!enabled) {
      this.restartOnEnd = false;
    }
  }

  isConversationMode(): boolean {
    return this.conversationMode;
  }

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

  resumeListening(): void {
    console.log('[BrowserVoiceService] resumeListening called:', {
      conversationMode: this.conversationMode,
      hasCallback: !!this.onResultCallback,
      isSpeaking: this.isSpeaking,
      currentLang: this.currentLang
    });
    
    if (this.conversationMode && this.onResultCallback && !this.isSpeaking) {
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

  async checkMicrophonePermission(): Promise<boolean> {
    try {
      if ('permissions' in navigator) {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return result.state === 'granted';
      }
      return false;
    } catch {
      return false;
    }
  }

  async prepareListening(): Promise<boolean> {
    if (!this.isSupported()) {
      throw new Error('Web Speech API not supported in this browser');
    }

    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
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

    this.stopListening();

    const SpeechRecognitionConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognitionConstructor();
    this.currentLang = lang;
    this.onResultCallback = onResult;
    this.onErrorCallback = onError || null;

    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = lang;

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

      if (interimTranscript) {
        console.log('[BrowserVoiceService] Calling onResultCallback with interim');
        this.onResultCallback?.(interimTranscript, false);
      }

      if (finalTranscript) {
        console.log('[BrowserVoiceService] Calling onResultCallback with final');
        this.onResultCallback?.(finalTranscript, true);
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // external: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error Aborted speech input is non-fatal during intentional stop or pause.
      if (event.error === 'aborted') {
        return;
      }

      const errorMessage = this.getErrorMessage(event.error);
      this.onErrorCallback?.(errorMessage);

      // external: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error Permission, service, and network failures must not trigger an immediate restart loop.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'network') {
        this.restartOnEnd = false;
        this.isListening = false;
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      
      if (this.restartOnEnd && this.recognition && !this.isSpeaking) {
        try {
          this.recognition.start();
        } catch {
          // Ignore restart errors — onerror / onend will fire if it's fatal.
        }
      }
    };

    try {
      this.recognition.start();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to start speech recognition';
      onError?.(errorMsg);
      throw new Error(errorMsg);
    }
  }

  async startListening(
    lang: string,
    onResult: SpeechResultCallback,
    onError?: ErrorCallback
  ): Promise<void> {
    this.startListeningSync(lang, onResult, onError);
  }

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

  getIsListening(): boolean {
    return this.isListening;
  }

  getCurrentLang(): string {
    return this.currentLang;
  }

  async resumeAudioContext(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  isAudioUnlockRequired(): boolean {
    return this.audioUnlockRequired;
  }

  async unlockAudio(): Promise<boolean> {
    try {
      const audio = new Audio();
      audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      audio.volume = 0.01;
      await audio.play();

      await this.resumeAudioContext();

      if (this.isMobileDevice() && 'speechSynthesis' in window) {
        const unlockUtterance = new SpeechSynthesisUtterance('');
        unlockUtterance.volume = 0;
        window.speechSynthesis.speak(unlockUtterance);
        window.speechSynthesis.cancel();
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

  async speakText(
    text: string,
    lang: string,
    onEnd?: SpeechEndCallback,
    options?: { rate?: number; pitch?: number; volume?: number; voiceName?: string; beforePlayback?: (playback: ReadingPlayback) => Promise<void>; onError?: () => void }
  ): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('Speech synthesis not supported');
    }

    await this.resumeAudioContext();

    // external: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices Voice discovery can complete asynchronously through voiceschanged.
    const voices = await this.waitForVoices();
    if (voices.length === 0 && isLinuxDesktopOs()) {
      throw new Error('No browser speech synthesis voices are available');
    }

    await new Promise(resolve => setTimeout(resolve, 50));

    await options?.beforePlayback?.({
      pause: () => window.speechSynthesis.pause(),
      resume: () => window.speechSynthesis.resume(),
    });

    this.isSpeaking = true;
    this.pauseListening();

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = options?.rate ?? 1;
    utterance.pitch = options?.pitch ?? 1;
    utterance.volume = options?.volume ?? 1;

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
        options?.onError?.();
        console.error('[BrowserVoiceService] Speech synthesis error:', event.error);

        if (event.error === 'not-allowed' || event.error === 'interrupted') {
          this.audioUnlockRequired = true;
        }

        let errorMessage = `Speech synthesis error: ${event.error || 'unknown'}`;
        if (event.error === 'not-allowed') {
          errorMessage = 'Audio blocked by browser autoplay policy. Please interact with the page first.';
        } else if (event.error === 'interrupted') {
          errorMessage = 'Speech was interrupted. Please try again.';
        }

        reject(new Error(errorMessage));
      };

      setTimeout(() => {
        if (!hasStarted) {
          console.warn('[BrowserVoiceService] Speech start timeout - audio may be blocked');
          this.audioUnlockRequired = true;
        }
      }, 2000);

      window.speechSynthesis.speak(utterance);
    });
  }

  cancelSpeech(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  getVoices(): SpeechSynthesisVoice[] {
    if (!('speechSynthesis' in window)) {
      return [];
    }
    return window.speechSynthesis.getVoices();
  }

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
      
      setTimeout(() => {
        resolve(window.speechSynthesis.getVoices());
        window.speechSynthesis.onvoiceschanged = null;
      }, 1000);
    });
  }

  private findBestVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
    let voice = voices.find(v => v.lang === lang);
    
    if (!voice) {
      const langCode = lang.split('-')[0];
      voice = voices.find(v => v.lang.startsWith(langCode));
    }
    
    if (!voice) {
      voice = voices.find(v => v.lang.startsWith(lang.split('-')[0]) && v.localService);
    }
    
    return voice || null;
  }

  private isMobileDevice(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod|android|mobile|webos|blackberry|iemobile|opera mini/i.test(userAgent);
  }

  private isIOSSafari(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/i.test(userAgent);
    const isSafari = /safari/i.test(userAgent) && !/chrome|crios|crmo/i.test(userAgent);
    return isIOS && isSafari;
  }

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

export const browserVoiceService = new BrowserVoiceService();
