/**
 * Voice capture for the opencode STT façade (opencode#1678 §8.4, design
 * §6.1/§6.2). Capture uses OpenChamber's own webview media-permissions
 * path — `navigator.mediaDevices.getUserMedia` — and holds the recorded
 * audio locally as a Blob. Nothing is submitted until the user reviews
 * and explicitly submits (§6.2); cancel in recording/reviewing discards
 * the audio immediately and locally (§6.1).
 *
 * A denied microphone permission is a typed state, not a modal dead
 * end: the composer renders the explanation and the file-attach
 * fallback (§6.1). Submission goes through `transcribeViaFacade` with
 * the runtime transport, so it carries the existing opencode server
 * auth and never a provider key (§3).
 */

import React from 'react';

import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    DEFAULT_TRANSCRIPTION_MODEL,
    FacadeTranscriptionError,
    MAX_AUDIO_DURATION_SECONDS,
    buildTranscriptionUrl,
    recordingDurationSeconds,
    transcribeViaFacade,
    validateAudioInput,
    voiceCaptureReducer,
    type TranscriptionResult,
    type VoiceCaptureState,
} from './facade-transcription';

export const isFacadeCaptureSupported = (): boolean =>
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function';

export interface PendingAudio {
    blob: Blob;
    filename: string;
    mediaType: string;
    durationSeconds?: number;
    /** Object URL for review playback; revoked when the audio is dropped. */
    url: string;
}

export interface UseFacadeVoiceCaptureOptions {
    /** §6.3: the transcript lands in the composer as editable draft text. */
    onInsert: (text: string) => void;
    /**
     * Called when a capture that can produce a transcript starts (record or
     * attach), so the composer can mark the dictation origin: a transcript
     * that lands after a session switch is kept for the draft it started in
     * (the same guard the streaming dictation path uses).
     */
    onStart?: () => void;
    model?: string;
    language?: string;
}

export interface FacadeVoiceCapture {
    state: VoiceCaptureState;
    supported: boolean;
    /** Elapsed recording seconds while state === 'recording'. */
    elapsedSeconds: number;
    pendingAudio: PendingAudio | null;
    error: FacadeTranscriptionError | null;
    result: TranscriptionResult | null;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
    cancel: () => void;
    attachFile: (file: File) => void;
    submit: () => Promise<void>;
    retry: () => void;
    discard: () => void;
}

const RECORDING_FILENAME = 'voice-capture.webm';

export const useFacadeVoiceCapture = (options: UseFacadeVoiceCaptureOptions): FacadeVoiceCapture => {
    const [state, dispatch] = React.useReducer(voiceCaptureReducer, 'idle');
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    const [pendingAudio, setPendingAudio] = React.useState<PendingAudio | null>(null);
    const [error, setError] = React.useState<FacadeTranscriptionError | null>(null);
    const [result, setResult] = React.useState<TranscriptionResult | null>(null);
    const [supported] = React.useState(isFacadeCaptureSupported);

    const recorderRef = React.useRef<MediaRecorder | null>(null);
    const streamRef = React.useRef<MediaStream | null>(null);
    const chunksRef = React.useRef<Blob[]>([]);
    const startedAtRef = React.useRef(0);
    const capReachedRef = React.useRef(false);
    // Microphone acquisition ownership: bumped when an acquisition starts
    // and whenever the capture is torn down (cancel / unmount). A
    // getUserMedia promise that resolves under a stale generation stops
    // its tracks immediately instead of starting an ownerless recording.
    const acquisitionRef = React.useRef(0);
    const acquiringRef = React.useRef(false);
    const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const pendingRef = React.useRef<PendingAudio | null>(null);
    const onInsertRef = React.useRef(options.onInsert);
    React.useEffect(() => {
        onInsertRef.current = options.onInsert;
    }, [options.onInsert]);
    const onStartRef = React.useRef(options.onStart);
    React.useEffect(() => {
        onStartRef.current = options.onStart;
    }, [options.onStart]);

    const setPending = React.useCallback((next: PendingAudio | null) => {
        if (pendingRef.current && pendingRef.current.url !== next?.url) {
            URL.revokeObjectURL(pendingRef.current.url);
        }
        pendingRef.current = next;
        setPendingAudio(next);
    }, []);

    const stopTracks = React.useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const finishRecording = React.useCallback(() => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === 'inactive') {
            return;
        }
        recorder.stop();
    }, []);

    const startRecording = React.useCallback(async () => {
        if (!isFacadeCaptureSupported()) {
            // Stay in idle with the explanation on screen: file attach
            // remains available (§6.1 — an absent/dead record control is
            // worse than a explained one with a working fallback).
            setError(
                new FacadeTranscriptionError(
                    'capture_unsupported',
                    'Recording is not available in this runtime. Attach an audio file instead.',
                ),
            );
            return;
        }
        if (acquiringRef.current || recorderRef.current?.state === 'recording') {
            // One acquisition owns the microphone at a time: an overlapping
            // start must not overwrite the live stream/recorder references.
            return;
        }
        acquiringRef.current = true;
        const acquisition = ++acquisitionRef.current;
        onStartRef.current?.();
        setError(null);
        setResult(null);
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (cause) {
            acquiringRef.current = false;
            // §6.1: a denied permission produces an in-composer explanation
            // with the file-attach fallback, not a modal dead end.
            const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
            setError(
                new FacadeTranscriptionError(
                    denied ? 'permission_denied' : 'capture_unsupported',
                    denied
                        ? 'Microphone permission was denied. Allow microphone access in the browser or system settings, or attach an audio file instead.'
                        : 'The microphone could not be opened. Attach an audio file instead.',
                ),
            );
            return;
        }
        acquiringRef.current = false;
        if (acquisition !== acquisitionRef.current) {
            // Torn down (cancel/unmount) while permission was pending: this
            // stream has no owner and no visible controls — stop it now.
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        streamRef.current = stream;
        chunksRef.current = [];
        capReachedRef.current = false;
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunksRef.current.push(event.data);
            }
        };
        recorder.onstop = () => {
            stopTracks();
            if (acquisition !== acquisitionRef.current) {
                // Superseded or torn down mid-recording: drop the audio
                // instead of surfacing a review for a dead capture.
                chunksRef.current = [];
                return;
            }
            const mediaType = recorder.mimeType || 'audio/webm';
            const blob = new Blob(chunksRef.current, { type: mediaType });
            chunksRef.current = [];
            const durationSeconds = recordingDurationSeconds(startedAtRef.current, Date.now(), capReachedRef.current);
            setPending({
                blob,
                filename: RECORDING_FILENAME,
                mediaType,
                durationSeconds,
                url: URL.createObjectURL(blob),
            });
            dispatch({ type: capReachedRef.current ? 'duration_cap_reached' : 'recording_stopped' });
        };
        startedAtRef.current = Date.now();
        setElapsedSeconds(0);
        dispatch({ type: 'start_recording' });
        recorder.start(250);
        timerRef.current = setInterval(() => {
            const elapsed = (Date.now() - startedAtRef.current) / 1000;
            setElapsedSeconds(elapsed);
            if (elapsed >= MAX_AUDIO_DURATION_SECONDS) {
                // §6.1: hitting the cap stops capture into reviewing; it
                // does not auto-submit.
                capReachedRef.current = true;
                finishRecording();
            }
        }, 250);
    }, [finishRecording, setPending, stopTracks]);

    const stopRecording = React.useCallback(() => {
        capReachedRef.current = false;
        finishRecording();
    }, [finishRecording]);

    const cancel = React.useCallback(() => {
        acquisitionRef.current += 1;
        acquiringRef.current = false;
        // §6.1: cancel discards the captured audio immediately and locally.
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            recorderRef.current.onstop = null;
            recorderRef.current.stop();
        }
        stopTracks();
        chunksRef.current = [];
        setPending(null);
        setError(null);
        dispatch({ type: 'cancel' });
        // From error (e.g. permission denied) cancel is a plain reset.
        dispatch({ type: 'reset' });
    }, [setPending, stopTracks]);

    const attachFile = React.useCallback(
        (file: File) => {
            onStartRef.current?.();
            setError(null);
            setResult(null);
            const invalid = validateAudioInput({ sizeBytes: file.size, mediaType: file.type, filename: file.name });
            if (invalid) {
                setError(invalid);
                return;
            }
            setPending({
                blob: file,
                filename: file.name,
                mediaType: file.type,
                url: URL.createObjectURL(file),
            });
            dispatch({ type: 'attach_file' });
        },
        [setPending],
    );

    const submit = React.useCallback(async () => {
        const pending = pendingRef.current;
        if (!pending) {
            return;
        }
        setError(null);
        dispatch({ type: 'submit' });
        try {
            const transcription = await transcribeViaFacade({
                fetchFn: (url, init) => runtimeFetch(url, init),
                url: buildTranscriptionUrl(opencodeClient.getBaseUrl()),
                file: pending.blob,
                filename: pending.filename,
                mediaType: pending.mediaType,
                durationSeconds: pending.durationSeconds,
                model: options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
                language: options.language,
            });
            setResult(transcription);
            dispatch({ type: 'submit_succeeded' });
            // §6.3: inserted as editable draft text — never auto-sent. The
            // audio is retained locally until the user discards it.
            onInsertRef.current(transcription.text);
        } catch (cause) {
            setError(
                cause instanceof FacadeTranscriptionError
                    ? cause
                    : new FacadeTranscriptionError('unknown_error', 'Transcription failed unexpectedly.'),
            );
            dispatch({ type: 'submit_failed' });
        }
    }, [options.language, options.model]);

    const retry = React.useCallback(() => {
        setError(null);
        dispatch({ type: 'retry' });
    }, []);

    const discard = React.useCallback(() => {
        setPending(null);
        setError(null);
        setResult(null);
        dispatch({ type: 'discard' });
        dispatch({ type: 'reset' });
    }, [setPending]);

    // Never leave a live microphone or a dangling object URL behind.
    React.useEffect(
        () => () => {
            acquisitionRef.current += 1;
            acquiringRef.current = false;
            stopTracks();
            if (pendingRef.current) {
                URL.revokeObjectURL(pendingRef.current.url);
            }
        },
        [stopTracks],
    );

    return {
        state,
        supported,
        elapsedSeconds,
        pendingAudio,
        error,
        result,
        startRecording,
        stopRecording,
        cancel,
        attachFile,
        submit,
        retry,
        discard,
    };
};
