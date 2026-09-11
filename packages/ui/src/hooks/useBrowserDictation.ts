/** Browser-owned recognition and local-only microphone metering. No server audio upload. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { isElectronShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useConfigStore } from '@/stores/useConfigStore';
import { BrowserRecognitionSession } from '@/lib/dictation/browser-recognition-session';
import { useDictationAudioSource } from '@/lib/dictation/use-dictation-audio-source';
import type { DictationStatus, UseDictationOptions, UseDictationResult } from '@/hooks/useDictation';

export const isBrowserDictationSupported = (): boolean => {
    if (!globalThis.window) return false;
    // Embedded Chromium exposes the interface without a working speech service.
    if (isElectronShell() || isVSCodeRuntime() || isCapacitorApp()) return false;
    return window.isSecureContext && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
};

export function useBrowserDictation(options: UseDictationOptions = {}): UseDictationResult {
    const { t } = useI18n();
    const meter = useDictationAudioSource({});
    const [status, setStatus] = useState<DictationStatus>('idle');
    const [partialTranscript, setPartialTranscript] = useState('');
    const [duration, setDuration] = useState(0);
    const [errorReason, setErrorReason] = useState<string | null>(null);
    const sessionRef = useRef<BrowserRecognitionSession | null>(null);
    const statusRef = useRef<DictationStatus>('idle');
    const textRef = useRef('');
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const transition = useCallback((next: DictationStatus) => {
        statusRef.current = next;
        setStatus(next);
    }, []);

    const cancelDictation = useCallback(async () => {
        // Clear ownership before aborting so late results cannot enter a new draft.
        const session = sessionRef.current;
        sessionRef.current = null;
        session?.cancel();
        transition('idle');
        textRef.current = '';
        setPartialTranscript('');
        setErrorReason(null);
        setDuration(0);
        await meter.stop();
    }, [meter, transition]);

    const startDictation = useCallback(async () => {
        if (statusRef.current !== 'idle' || optionsRef.current.canStart?.() === false) return;
        if (!isBrowserDictationSupported()) {
            setErrorReason('unsupported');
            transition('failed');
            return;
        }
        setErrorReason(null);
        textRef.current = '';
        setPartialTranscript('');
        setDuration(0);
        transition('recording');
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition: SpeechRecognition;
        try {
            recognition = new Recognition();
        } catch {
            setErrorReason('start-failed');
            transition('failed');
            return;
        }
        const fail = (code: string) => {
            if (sessionRef.current !== session) return;
            sessionRef.current = null;
            session.cancel();
            setErrorReason(code);
            transition('failed');
            void meter.stop();
        };
        const session = new BrowserRecognitionSession(recognition, {
            onText: (text) => {
                if (sessionRef.current !== session) return;
                textRef.current = text;
                setPartialTranscript(text);
            },
            onError: fail,
        });
        sessionRef.current = session;
        const language = useConfigStore.getState().sttLanguage.trim();
        // Keep recognition.start in the user gesture, before awaiting mic permission.
        session.start(language && language.toLowerCase() !== 'auto' ? language : navigator.language || 'en-US');
        if (sessionRef.current !== session) return;
        try {
            await meter.start();
        } catch {
            fail('audio-capture');
        }
    }, [meter, transition]);

    const confirmDictation = useCallback(async (): Promise<string | null> => {
        const session = sessionRef.current;
        if (!session || statusRef.current !== 'recording') return null;
        transition('uploading');
        void meter.stop();
        // stop() may produce one last result. Do not insert interim text early.
        const text = await session.finish();
        if (sessionRef.current !== session) return null;
        void cancelDictation();
        if (!text?.trim()) return null;
        optionsRef.current.onTranscript?.(text.trim());
        return text.trim();
    }, [cancelDictation, meter, transition]);

    const acceptPartialTranscript = useCallback(() => {
        if (statusRef.current !== 'failed') return null;
        const text = textRef.current.trim();
        void cancelDictation();
        if (!text) return null;
        optionsRef.current.onTranscript?.(text);
        return text;
    }, [cancelDictation]);

    useEffect(() => {
        if (status !== 'recording') return;
        const timer = setInterval(() => setDuration((previous) => previous + 1), 1000);
        return () => clearInterval(timer);
    }, [status]);

    useEffect(() => () => {
        const session = sessionRef.current;
        sessionRef.current = null;
        session?.cancel();
        void meter.stop();
    }, [meter]);

    // No buffered audio exists to replay. The UI offers salvage or discard instead.
    const retryFailedDictation = useCallback(async () => null, []);
    const discardFailedDictation = useCallback(() => { void cancelDictation(); }, [cancelDictation]);
    const error = errorReason === 'unsupported'
        ? t('settings.voice.page.browserTest.unavailable')
        : errorReason ? t('settings.voice.page.browserTest.error', { code: errorReason }) : null;
    useEffect(() => {
        if (error) optionsRef.current.onError?.(new Error(error));
    }, [error]);

    return { status, isRecording: status === 'recording', isProcessing: status === 'uploading',
        partialTranscript, subscribeLevel: meter.subscribeLevel, duration, error, errorReason,
        startDictation, confirmDictation, cancelDictation, retryFailedDictation,
        acceptPartialTranscript, discardFailedDictation };
}
