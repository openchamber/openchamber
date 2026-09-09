/**
 * Browser (Web Speech API) dictation engine.
 *
 * Same contract as `useDictation`, but recognition runs entirely in the
 * browser: no mic capture graph, no server stream, and transcripts arrive as
 * Web Speech results instead of a server response. There is no uploading
 * phase — `partialTranscript` accumulates what the provider has recognized so
 * far and also serves as the salvage text if dictation fails.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { useConfigStore } from '@/stores/useConfigStore';
import type { DictationStatus, UseDictationOptions, UseDictationResult } from '@/hooks/useDictation';

const DURATION_TICK_MS = 1000;

const getRecognitionLanguage = (): string => {
    const configured = useConfigStore.getState().sttLanguage?.trim();
    if (configured && configured.toLowerCase() !== 'auto') {
        return configured;
    }
    return navigator.language || 'en-US';
};

/** Compose the full transcript from confirmed sentences plus any pending interim result. */
const composeTranscript = (finals: string, interim: string): string => {
    return [finals.trim(), interim.trim()].filter(Boolean).join(' ');
};

export function useBrowserDictation(options: UseDictationOptions = {}): UseDictationResult {
    const { onTranscript, onError, canStart } = options;

    const [status, setStatus] = useState<DictationStatus>('idle');
    const [partialTranscript, setPartialTranscript] = useState('');
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [errorReason, setErrorReason] = useState<string | null>(null);

    const statusRef = useRef(status);
    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    const finalsRef = useRef('');
    const interimRef = useRef('');
    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const actionGateRef = useRef({ starting: false, confirming: false, cancelling: false });

    const onTranscriptRef = useRef(onTranscript);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        onTranscriptRef.current = onTranscript;
        onErrorRef.current = onError;
    }, [onTranscript, onError]);

    const stopDurationTracking = useCallback(() => {
        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }
    }, []);

    const startDurationTracking = useCallback(() => {
        if (durationIntervalRef.current) {
            return;
        }
        durationIntervalRef.current = setInterval(() => {
            setDuration((prev) => prev + 1);
        }, DURATION_TICK_MS);
    }, []);

    const reportError = useCallback((message: string) => {
        setError(message);
        onErrorRef.current?.(new Error(message));
    }, []);

    const updateTranscript = useCallback((finals: string, interim: string) => {
        finalsRef.current = finals;
        interimRef.current = interim;
        setPartialTranscript(composeTranscript(finals, interim));
    }, []);

    const clearRecognitionState = useCallback(() => {
        finalsRef.current = '';
        interimRef.current = '';
        setPartialTranscript('');
    }, []);

    const handleSuccess = useCallback(
        (text: string): string | null => {
            setDuration(0);
            setStatus('idle');
            statusRef.current = 'idle';
            const transcriptText = text.trim();
            clearRecognitionState();
            if (!transcriptText) {
                return null;
            }
            onTranscriptRef.current?.(transcriptText);
            return transcriptText;
        },
        [clearRecognitionState],
    );

    const startDictation = useCallback(async () => {
        const gate = actionGateRef.current;
        if (gate.starting || gate.confirming || gate.cancelling) {
            return;
        }
        if (statusRef.current !== 'idle') {
            return;
        }
        if (canStart && !canStart()) {
            return;
        }

        gate.starting = true;
        setError(null);
        setErrorReason(null);
        setPartialTranscript('');
        setDuration(0);
        setStatus('recording');
        statusRef.current = 'recording';
        clearRecognitionState();

        try {
            await browserVoiceService.startListening(getRecognitionLanguage(), (text, isFinal) => {
                if (isFinal) {
                    updateTranscript(composeTranscript(finalsRef.current, text), '');
                } else {
                    updateTranscript(finalsRef.current, text);
                }
            }, (message) => {
                // Web Speech reports transient errors (no-speech, network
                // blips) while continuing to listen, and fatal ones after
                // stopping. Surface the message either way; the accumulated
                // transcript stays available for confirm or salvage.
                setError(message);
            });
            startDurationTracking();
        } catch (err) {
            browserVoiceService.stopListening();
            stopDurationTracking();
            setStatus('idle');
            statusRef.current = 'idle';
            reportError(err instanceof Error ? err.message : String(err));
        } finally {
            gate.starting = false;
        }
    }, [canStart, clearRecognitionState, reportError, startDurationTracking, stopDurationTracking, updateTranscript]);

    const cancelDictation = useCallback(async () => {
        const gate = actionGateRef.current;
        if (gate.cancelling) {
            return;
        }
        if (statusRef.current !== 'recording') {
            return;
        }
        gate.cancelling = true;
        stopDurationTracking();
        setDuration(0);
        setError(null);
        setErrorReason(null);
        browserVoiceService.stopListening();
        setStatus('idle');
        statusRef.current = 'idle';
        clearRecognitionState();
        gate.cancelling = false;
    }, [clearRecognitionState, stopDurationTracking]);

    const confirmDictation = useCallback(async (): Promise<string | null> => {
        const gate = actionGateRef.current;
        if (gate.confirming) {
            return null;
        }
        if (statusRef.current !== 'recording') {
            return null;
        }

        gate.confirming = true;
        stopDurationTracking();
        browserVoiceService.stopListening();
        try {
            return handleSuccess(composeTranscript(finalsRef.current, interimRef.current));
        } finally {
            gate.confirming = false;
        }
    }, [handleSuccess, stopDurationTracking]);

    // Web Speech results are final the moment they arrive — there is no
    // buffered audio to replay, so failed dictations offer only the partial.
    const retryFailedDictation = useCallback(async (): Promise<string | null> => {
        return null;
    }, []);

    const acceptPartialTranscript = useCallback((): string | null => {
        if (statusRef.current !== 'failed') {
            return null;
        }
        const text = partialTranscript.trim();
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        setError(null);
        setErrorReason(null);
        browserVoiceService.stopListening();
        clearRecognitionState();
        if (!text) {
            return null;
        }
        onTranscriptRef.current?.(text);
        return text;
    }, [clearRecognitionState, partialTranscript]);

    const discardFailedDictation = useCallback(() => {
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        setError(null);
        setErrorReason(null);
        browserVoiceService.stopListening();
        clearRecognitionState();
    }, [clearRecognitionState]);

    useEffect(() => {
        return () => {
            stopDurationTracking();
            browserVoiceService.stopListening();
        };
    }, [stopDurationTracking]);

    // Web Speech exposes no audio levels; the waveform renders its idle trace.
    const subscribeLevel = useCallback((): (() => void) => {
        return () => undefined;
    }, []);

    return {
        status,
        isRecording: status === 'recording',
        isProcessing: false,
        partialTranscript,
        subscribeLevel,
        duration,
        error,
        errorReason,
        startDictation,
        confirmDictation,
        cancelDictation,
        retryFailedDictation,
        acceptPartialTranscript,
        discardFailedDictation,
    };
}
