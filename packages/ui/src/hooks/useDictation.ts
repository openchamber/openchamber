
import { useCallback, useEffect, useRef, useState } from 'react';

import { dictationClient, type DictationClient, type DictationStartOptions } from '@/lib/dictation/dictation-client';
import { DictationStreamSender } from '@/lib/dictation/dictation-stream-sender';
import { useDictationAudioSource, type DictationLevelListener } from '@/lib/dictation/use-dictation-audio-source';
import { useConfigStore } from '@/stores/useConfigStore';
import { readTranscriptionPrompt } from '@/stores/useTranscriptionPromptStore';

export type DictationStatus = 'idle' | 'recording' | 'uploading' | 'failed';

export interface UseDictationOptions {
    onTranscript?: (text: string) => void;
    onError?: (error: Error) => void;
    canStart?: () => boolean;
}

export interface UseDictationResult {
    status: DictationStatus;
    isRecording: boolean;
    isProcessing: boolean;
    partialTranscript: string;
    subscribeLevel: (listener: DictationLevelListener) => () => void;
    duration: number;
    error: string | null;
    errorReason: string | null;
    startDictation: () => Promise<void>;
    confirmDictation: () => Promise<string | null>;
    cancelDictation: () => Promise<void>;
    retryFailedDictation: () => Promise<string | null>;
    acceptPartialTranscript: () => string | null;
    discardFailedDictation: () => void;
}

const DURATION_TICK_MS = 1000;

const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

export const getDictationStartOptions = (): DictationStartOptions => {
    const state = useConfigStore.getState();
    const language = state.sttLanguage?.trim();
    const correct = state.sttCorrectTranscript ? { correct: true } : {};
    if (state.sttProvider === 'openai-compatible') {
        const openaiCompatible: NonNullable<DictationStartOptions['openaiCompatible']> = {
            baseUrl: state.sttServerUrl,
            model: state.sttModel,
            endpointPath: state.sttEndpointPath || undefined,
            keyProvider: state.sttKeyProvider,
        };
        const prompt = readTranscriptionPrompt().trim();
        if (prompt) openaiCompatible.prompt = prompt;
        return {
            provider: 'openai-compatible',
            ...(language ? { language } : {}),
            ...correct,
            openaiCompatible,
        };
    }
    return {
        provider: 'local',
        ...(language ? { language } : {}),
        ...correct,
        localModel: state.sttLocalModel,
    };
};

export function useDictation(options: UseDictationOptions = {}, client: DictationClient = dictationClient): UseDictationResult {
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

    const latestPartialRef = useRef('');
    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const actionGateRef = useRef({ starting: false, confirming: false, cancelling: false });

    const onTranscriptRef = useRef(onTranscript);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        onTranscriptRef.current = onTranscript;
        onErrorRef.current = onError;
    }, [onTranscript, onError]);

    const senderRef = useRef<DictationStreamSender | null>(null);
    if (!senderRef.current) {
        senderRef.current = new DictationStreamSender({
            client,
            getStartOptions: getDictationStartOptions,
        });
    }

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

    const reportError = useCallback((err: unknown) => {
        const normalized = toError(err);
        setError(normalized.message);
        const reason = (normalized as Error & { reasonCode?: string }).reasonCode;
        setErrorReason(typeof reason === 'string' ? reason : null);
        onErrorRef.current?.(normalized);
    }, []);

    const clearError = useCallback(() => {
        setError(null);
        setErrorReason(null);
    }, []);

    const clearStreamingState = useCallback(() => {
        senderRef.current?.clearAll();
        latestPartialRef.current = '';
        setPartialTranscript('');
    }, []);

    useEffect(() => {
        return client.onPartial((dictationId, text) => {
            const activeDictationId = senderRef.current?.getDictationId();
            if (!activeDictationId || dictationId !== activeDictationId) {
                return;
            }
            latestPartialRef.current = text;
            setPartialTranscript(text);
        });
    }, [client]);

    useEffect(() => {
        return client.subscribeConnectionStatus((connected) => {
            if (!connected) {
                return;
            }
            if (statusRef.current !== 'recording' && statusRef.current !== 'uploading') {
                return;
            }
            void senderRef.current?.resumeStream().catch((err) => {
                if (!actionGateRef.current.confirming) {
                    reportError(err);
                }
            });
        });
    }, [client, reportError]);

    const handleSuccess = useCallback(
        (text: string): string | null => {
            setDuration(0);
            setStatus('idle');
            const transcriptText = text.trim().length > 0 ? text.trim() : latestPartialRef.current.trim();
            clearStreamingState();
            if (!transcriptText) {
                return null;
            }
            onTranscriptRef.current?.(transcriptText);
            return transcriptText;
        },
        [clearStreamingState],
    );

    const handleFailure = useCallback(
        (failure: unknown) => {
            senderRef.current?.cancel();
            if (senderRef.current?.hasSegments()) {
                setStatus('failed');
            } else {
                setStatus('idle');
            }
            reportError(failure);
        },
        [reportError],
    );

    const audio = useDictationAudioSource({
        onPcmSegment: (audioData) => {
            senderRef.current?.enqueueSegment(audioData);
            if (senderRef.current?.runtimeChanged && statusRef.current === 'recording' && !actionGateRef.current.confirming) {
                statusRef.current = 'failed';
                stopDurationTracking();
                void audioStopRef.current().catch(() => undefined);
                handleFailure(new Error('Runtime changed'));
            }
        },
        onError: (err) => {
            onErrorRef.current?.(err);
        },
    });
    const audioStopRef = useRef<() => Promise<void>>(async () => undefined);
    useEffect(() => {
        audioStopRef.current = audio.stop;
    }, [audio.stop]);

    useEffect(() => {
        return client.subscribeStreamError((dictationId, streamError) => {
            if (senderRef.current?.getDictationId() !== dictationId) {
                return;
            }
            const gate = actionGateRef.current;
            if (gate.starting) {
                return;
            }
            if (streamError.reasonCode === 'model_download_in_progress') {
                reportError(streamError);
                return;
            }
            if (streamError.reasonCode === 'stream_released' && (gate.confirming || statusRef.current === 'recording')) {
                senderRef.current?.markReleased();
                return;
            }
            if (gate.confirming) {
                senderRef.current?.stopWaitingForDrain();
                return;
            }
            if (statusRef.current !== 'recording' && statusRef.current !== 'uploading') {
                return;
            }
            client.abandonDictationStream(dictationId);
            stopDurationTracking();
            void audioStopRef.current().catch(() => undefined);
            handleFailure(streamError);
        });
    }, [client, handleFailure, reportError, stopDurationTracking]);

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
        clearError();
        setPartialTranscript('');
        setDuration(0);
        setStatus('recording');
        statusRef.current = 'recording';
        clearStreamingState();

        try {
            if (!(await audio.start())) {
                return;
            }
            startDurationTracking();
            await senderRef.current?.restartStream().catch((err) => {
                reportError(err);
            });
        } catch (err) {
            await audio.stop().catch(() => undefined);
            stopDurationTracking();
            setStatus('idle');
            statusRef.current = 'idle';
            reportError(err);
        } finally {
            gate.starting = false;
        }
    }, [audio, canStart, clearError, clearStreamingState, reportError, startDurationTracking, stopDurationTracking]);

    const cancelDictation = useCallback(async () => {
        const gate = actionGateRef.current;
        if (gate.cancelling) {
            return;
        }
        if (statusRef.current !== 'recording' && statusRef.current !== 'uploading') {
            return;
        }
        gate.cancelling = true;
        stopDurationTracking();
        setDuration(0);
        clearError();

        setStatus('idle');
        statusRef.current = 'idle';
        const stopped = audio.stop();
        clearStreamingState();

        try {
            await stopped;
        } catch {
            // Cancelled anyway; mic teardown failures are not user-actionable.
        } finally {
            gate.cancelling = false;
        }
    }, [audio, clearError, clearStreamingState, stopDurationTracking]);

    const confirmDictation = useCallback(async (): Promise<string | null> => {
        const gate = actionGateRef.current;
        if (gate.confirming) {
            return null;
        }
        if (statusRef.current !== 'recording') {
            return null;
        }

        gate.confirming = true;
        clearError();
        stopDurationTracking();

        try {
            await audio.stop();
            setStatus('uploading');
            statusRef.current = 'uploading';

            const finalSeq = senderRef.current?.getFinalSeq() ?? -1;
            if (finalSeq < 0) {
                return handleSuccess('');
            }

            const result = await senderRef.current!.finish(finalSeq);
            return handleSuccess(result.text);
        } catch (err) {
            if (statusRef.current === 'uploading') {
                handleFailure(err);
            }
            return null;
        } finally {
            gate.confirming = false;
        }
    }, [audio, clearError, handleFailure, handleSuccess, stopDurationTracking]);

    const retryFailedDictation = useCallback(async (): Promise<string | null> => {
        const gate = actionGateRef.current;
        if (gate.confirming || statusRef.current !== 'failed' || !senderRef.current?.hasSegments()) {
            return null;
        }
        gate.confirming = true;
        clearError();
        setStatus('uploading');
        statusRef.current = 'uploading';

        try {
            senderRef.current.cancel();
            const finalSeq = senderRef.current.getFinalSeq();
            const result = await senderRef.current.finish(finalSeq);
            return handleSuccess(result.text);
        } catch (err) {
            if (statusRef.current === 'uploading') {
                handleFailure(err);
            }
            return null;
        } finally {
            gate.confirming = false;
        }
    }, [clearError, handleFailure, handleSuccess]);

    const acceptPartialTranscript = useCallback((): string | null => {
        if (statusRef.current !== 'failed') {
            return null;
        }
        const text = latestPartialRef.current.trim();
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        clearError();
        clearStreamingState();
        if (!text) {
            return null;
        }
        onTranscriptRef.current?.(text);
        return text;
    }, [clearError, clearStreamingState]);

    const discardFailedDictation = useCallback(() => {
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        clearError();
        clearStreamingState();
    }, [clearError, clearStreamingState]);

    useEffect(() => {
        if (status !== 'recording' || errorReason !== 'model_download_in_progress') {
            return;
        }
        const interval = setInterval(() => {
            if (statusRef.current !== 'recording' || senderRef.current?.getDictationId()) {
                return;
            }
            senderRef.current?.restartStream().then(() => {
                clearError();
            }).catch((err) => {
                reportError(err);
            });
        }, 3000);
        return () => clearInterval(interval);
    }, [status, errorReason, clearError, reportError]);

    useEffect(() => {
        return () => {
            stopDurationTracking();
            void audioStopRef.current().catch(() => undefined);
            senderRef.current?.clearAll();
        };
    }, [stopDurationTracking]);

    return {
        status,
        isRecording: status === 'recording',
        isProcessing: status === 'uploading',
        partialTranscript,
        subscribeLevel: audio.subscribeLevel,
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
