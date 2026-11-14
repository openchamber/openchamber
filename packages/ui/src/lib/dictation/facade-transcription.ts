/**
 * Client for the opencode STT façade (developing-today-forks/opencode#1678
 * §8.4, design specs/2026-11-08_design_voice-input-stt-facade.md §2/§5/§6).
 *
 * The façade is `POST /v1/audio/transcriptions` on the opencode server:
 * multipart form data in, the normalized envelope of design §2.3 out, and
 * the OpenAI-shaped error envelope of §2.4 on failure. The caller
 * authenticates with the existing opencode server auth only — an STT
 * provider key is never sent to, stored by, or renewable by this client
 * (design §3, the #1146 rule).
 *
 * This module is the pure half of the feature: caps, validation, envelope
 * and error parsing, the §6.1 capture state machine, the §5.3 pre-submit
 * privacy notice, and §6.3 draft insertion. Capture (getUserMedia /
 * MediaRecorder) and rendering live in `use-facade-voice-capture` and
 * `FacadeVoiceCapture`; everything here is testable without a DOM.
 */

/** Façade route on the opencode server (design §2.1/§2.2). */
export const TRANSCRIPTION_ENDPOINT_PATH = '/v1/audio/transcriptions';

/**
 * Absolute façade URL from the opencode base URL the UI is configured
 * with. The base names the `/api` mount the OpenChamber server exposes;
 * the façade lives at the server root beside it — the same root
 * derivation the generated opencode client applies in
 * `lib/opencode/client.ts` (`toOpencodeClientRoot`).
 */
export const buildTranscriptionUrl = (opencodeBaseUrl: string): string => {
    const root = opencodeBaseUrl.replace(/\/api\/*$/, '').replace(/\/+$/, '');
    return `${root}${TRANSCRIPTION_ENDPOINT_PATH}`;
};

/** Default concrete ref: the phase-1 end-to-end registration (§8.1). */
export const DEFAULT_TRANSCRIPTION_MODEL = 'openai/whisper-1';

/**
 * Concrete refs registered in the façade's TRANSCRIPTION_MODELS registry
 * (opencode packages/core/src/transcription-facade.ts). Every phase-1
 * registration is a hosted HTTP backend, so every one of these refs has
 * `audio_leaves_machine = true` in the registry (design §3/§5.3).
 */
export const HOSTED_TRANSCRIPTION_MODELS: ReadonlyArray<string> = [
    'openai/whisper-1',
    'deepgram/nova-3',
    'google/gemini-3.5-transcribe',
    'assemblyai/universal-3-5-pro',
    'elevenlabs/scribe_v2',
];

/** §5.2 caps: bounded by default, never silently unlimited. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_AUDIO_DURATION_SECONDS = 600;

/**
 * §5.2 accepted containers floor (phase-1 registrations): a file is
 * accepted when its media type is in this set; when the browser reports
 * no usable type, the filename extension decides (§5.1 — the façade
 * still makes the final call and answers `unsupported_media_type`).
 */
export const ACCEPTED_AUDIO_MEDIA_TYPES: ReadonlyArray<string> = [
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/webm',
    'audio/ogg',
    'audio/flac',
    'audio/x-flac',
    'audio/aac',
    'audio/aiff',
    'audio/x-aiff',
];

const ACCEPTED_AUDIO_EXTENSIONS: ReadonlyArray<string> = [
    '.mp3',
    '.mp4',
    '.m4a',
    '.wav',
    '.webm',
    '.ogg',
    '.flac',
    '.aac',
    '.aiff',
    '.aif',
];

/** Error codes of design §2.4, plus the client-side capture failures. */
export type FacadeTranscriptionErrorCode =
    | 'invalid_audio'
    | 'unsupported_media_type'
    | 'audio_too_large'
    | 'duration_too_long'
    | 'stream_not_supported'
    | 'timestamps_not_supported'
    | 'unauthenticated'
    | 'model_not_found'
    | 'quota_exceeded'
    | 'rate_limit'
    | 'upstream_failure'
    | 'no_route_candidate'
    | 'permission_denied'
    | 'capture_unsupported'
    | 'network_error'
    | 'invalid_response'
    | 'unknown_error';

const RETRYABLE_CODES: ReadonlySet<FacadeTranscriptionErrorCode> = new Set([
    'rate_limit',
    'quota_exceeded',
    'upstream_failure',
    'no_route_candidate',
    'network_error',
]);

export class FacadeTranscriptionError extends Error {
    readonly code: FacadeTranscriptionErrorCode;
    readonly status?: number;
    readonly retryable: boolean;

    constructor(code: FacadeTranscriptionErrorCode, message: string, status?: number) {
        super(message);
        this.name = 'FacadeTranscriptionError';
        this.code = code;
        if (status !== undefined) {
            this.status = status;
        }
        this.retryable = RETRYABLE_CODES.has(code);
    }
}

export interface AudioInputInfo {
    sizeBytes: number;
    mediaType?: string;
    filename?: string;
    /** Known duration in seconds (recorded clip or probed file), if any. */
    durationSeconds?: number;
}

export const isAcceptedAudioMediaType = (mediaType?: string, filename?: string): boolean => {
    const normalized = (mediaType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (normalized && ACCEPTED_AUDIO_MEDIA_TYPES.includes(normalized)) {
        return true;
    }
    if (normalized && normalized !== 'application/octet-stream') {
        return false;
    }
    // No usable media type reported: fall back to the file extension.
    const name = (filename ?? '').toLowerCase();
    return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
};

/**
 * §5.2 client-side cap check. Exceeding a cap is a typed error detected
 * before provider submission — audio is never truncated silently, here
 * or in the façade. Returns null when the input is within caps.
 */
export const validateAudioInput = (info: AudioInputInfo): FacadeTranscriptionError | null => {
    if (!Number.isFinite(info.sizeBytes) || info.sizeBytes <= 0) {
        return new FacadeTranscriptionError('invalid_audio', 'The audio is empty or could not be read.');
    }
    if (!isAcceptedAudioMediaType(info.mediaType, info.filename)) {
        return new FacadeTranscriptionError(
            'unsupported_media_type',
            `Unsupported audio type${info.mediaType ? ` (${info.mediaType})` : ''}. Accepted containers: wav, mp3, m4a, webm, ogg, flac.`,
        );
    }
    if (info.sizeBytes > MAX_AUDIO_BYTES) {
        return new FacadeTranscriptionError(
            'audio_too_large',
            `Audio is ${(info.sizeBytes / (1024 * 1024)).toFixed(1)} MiB; the limit is 25 MiB.`,
        );
    }
    if (
        info.durationSeconds !== undefined &&
        Number.isFinite(info.durationSeconds) &&
        info.durationSeconds > MAX_AUDIO_DURATION_SECONDS
    ) {
        return new FacadeTranscriptionError(
            'duration_too_long',
            `Audio is ${Math.round(info.durationSeconds)}s; the limit is ${MAX_AUDIO_DURATION_SECONDS}s per transcription.`,
        );
    }
    return null;
};

/**
 * §5.3: whether submitting audio for this model ref sends audio off this
 * machine. The registry server-side is the source of truth; every
 * phase-1 registration is a hosted HTTP backend (`audio_leaves_machine:
 * true`), and a `native-local` backend is the only path that can promise
 * otherwise — no such registration exists yet, so an unrecognized ref is
 * surfaced as leaving the machine rather than implying a privacy
 * property the UI cannot verify.
 */
export const audioLeavesMachine = (modelRef: string): boolean => {
    void modelRef;
    return true;
};

/** §5.3 pre-submit surfacing text for the review step. */
export const preSubmitPrivacyNotice = (modelRef: string): string =>
    audioLeavesMachine(modelRef)
        ? `Submitting sends this audio to the transcription provider for ${modelRef} through the server. Audio leaves this machine, and the provider's retention policy applies to the submitted audio. The server itself retains no audio after the call.`
        : `Submitting transcribes this audio with the on-device model ${modelRef}. Audio does not leave this machine.`;

export interface TranscriptSegment {
    text: string;
    start: number;
    end: number;
    speaker?: string;
}

export interface TranscriptWord {
    word: string;
    start: number;
    end: number;
    speaker?: string;
    confidence?: number;
}

/** §6.3 provenance: shown in the review/insertion affordance, never pasted into the text. */
export interface TranscriptProvenance {
    provider?: string;
    model?: string;
    durationSeconds?: number;
    language?: string;
}

export interface TranscriptionResult {
    text: string;
    language?: string;
    durationSeconds?: number;
    segments?: TranscriptSegment[];
    words?: TranscriptWord[];
    provenance: TranscriptProvenance;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Parse the §2.3 envelope. `text` is always present on success; optional
 * fields are present exactly when the provider reported them — absence
 * means "not reported", so nothing is fabricated here either.
 */
export const parseTranscriptionEnvelope = (data: unknown): TranscriptionResult => {
    if (!isRecord(data) || typeof data.text !== 'string') {
        throw new FacadeTranscriptionError(
            'invalid_response',
            'The transcription response did not carry transcript text.',
        );
    }
    const language = optionalString(data.language);
    const durationSeconds = optionalNumber(data.duration);
    const segments: TranscriptSegment[] | undefined = Array.isArray(data.segments)
        ? data.segments.flatMap((segment) => {
              if (!isRecord(segment) || typeof segment.text !== 'string') {
                  return [];
              }
              const start = optionalNumber(segment.start);
              const end = optionalNumber(segment.end);
              if (start === undefined || end === undefined) {
                  return [];
              }
              const speaker = optionalString(segment.speaker);
              return [{ text: segment.text, start, end, ...(speaker ? { speaker } : {}) }];
          })
        : undefined;
    const words: TranscriptWord[] | undefined = Array.isArray(data.words)
        ? data.words.flatMap((word) => {
              if (!isRecord(word) || typeof word.word !== 'string') {
                  return [];
              }
              const start = optionalNumber(word.start);
              const end = optionalNumber(word.end);
              if (start === undefined || end === undefined) {
                  return [];
              }
              const speaker = optionalString(word.speaker);
              const confidence = optionalNumber(word.confidence);
              return [
                  {
                      word: word.word,
                      start,
                      end,
                      ...(speaker ? { speaker } : {}),
                      ...(confidence !== undefined ? { confidence } : {}),
                  },
              ];
          })
        : undefined;
    const providerMetadata = isRecord(data.provider_metadata) ? data.provider_metadata : undefined;
    const provenance: TranscriptProvenance = {
        ...(optionalString(providerMetadata?.provider) ? { provider: optionalString(providerMetadata?.provider) } : {}),
        ...(optionalString(providerMetadata?.model) ? { model: optionalString(providerMetadata?.model) } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(language ? { language } : {}),
    };
    return {
        text: data.text,
        ...(language ? { language } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(segments ? { segments } : {}),
        ...(words ? { words } : {}),
        provenance,
    };
};

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
    'invalid_audio',
    'unsupported_media_type',
    'audio_too_large',
    'stream_not_supported',
    'timestamps_not_supported',
    'unauthenticated',
    'model_not_found',
    'quota_exceeded',
    'rate_limit',
    'upstream_failure',
    'no_route_candidate',
]);

/** Map a non-2xx façade response to a typed error (design §2.4). */
export const parseFacadeError = (status: number, data: unknown): FacadeTranscriptionError => {
    const error = isRecord(data) && isRecord(data.error) ? data.error : undefined;
    const bodyCode = optionalString(error?.code);
    const bodyMessage = optionalString(error?.message);
    if (bodyCode && KNOWN_ERROR_CODES.has(bodyCode)) {
        // 413 carries audio_too_large when the cap is detected from headers (§2.4).
        return new FacadeTranscriptionError(
            bodyCode as FacadeTranscriptionErrorCode,
            bodyMessage ?? `Transcription failed (${bodyCode}).`,
            status,
        );
    }
    const byStatus: FacadeTranscriptionErrorCode =
        status === 401
            ? 'unauthenticated'
            : status === 404
              ? 'model_not_found'
              : status === 413
                ? 'audio_too_large'
                : status === 429
                  ? 'rate_limit'
                  : status >= 500
                    ? 'upstream_failure'
                    : status === 400
                      ? 'invalid_audio'
                      : 'unknown_error';
    return new FacadeTranscriptionError(byStatus, bodyMessage ?? `Transcription failed (HTTP ${status}).`, status);
};

export interface TranscriptionRequestOptions {
    model?: string;
    language?: string;
    prompt?: string;
}

/** §2.2 request shape: multipart/form-data with OpenAI-compatible field names. */
export const buildTranscriptionFormData = (
    file: Blob,
    filename: string,
    options: TranscriptionRequestOptions = {},
): FormData => {
    const form = new FormData();
    form.append('file', file, filename);
    form.append('model', options.model ?? DEFAULT_TRANSCRIPTION_MODEL);
    if (options.language) {
        form.append('language', options.language);
    }
    if (options.prompt) {
        form.append('prompt', options.prompt);
    }
    form.append('response_format', 'json');
    return form;
};

export interface TranscriptionFetchInit {
    method: string;
    body: FormData;
}

export interface TranscriptionFetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}

/** The slice of the runtime transport this client needs (runtimeFetch in the app). */
export type TranscriptionFetch = (url: string, init: TranscriptionFetchInit) => Promise<TranscriptionFetchResponse>;

export interface TranscribeViaFacadeInput {
    fetchFn: TranscriptionFetch;
    /** Absolute URL of the façade endpoint (opencode base root + path). */
    url: string;
    file: Blob;
    filename: string;
    mediaType?: string;
    durationSeconds?: number;
    model?: string;
    language?: string;
    prompt?: string;
}

/**
 * One façade call (§6.2): validate against the §5.2 caps before any
 * network traffic, submit once, and return the parsed envelope — or a
 * typed FacadeTranscriptionError the composer can render with
 * retry/discard. No provider key is attached here; the transport
 * carries the existing server auth.
 */
export const transcribeViaFacade = async (input: TranscribeViaFacadeInput): Promise<TranscriptionResult> => {
    const invalid = validateAudioInput({
        sizeBytes: input.file.size,
        mediaType: input.mediaType ?? input.file.type,
        filename: input.filename,
        durationSeconds: input.durationSeconds,
    });
    if (invalid) {
        throw invalid;
    }
    let response: TranscriptionFetchResponse;
    try {
        response = await input.fetchFn(input.url, {
            method: 'POST',
            body: buildTranscriptionFormData(input.file, input.filename, {
                model: input.model,
                language: input.language,
                prompt: input.prompt,
            }),
        });
    } catch (cause) {
        throw new FacadeTranscriptionError(
            'network_error',
            cause instanceof Error ? `Could not reach the transcription server: ${cause.message}` : 'Could not reach the transcription server.',
        );
    }
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        throw parseFacadeError(response.status, data);
    }
    return parseTranscriptionEnvelope(data);
};

/**
 * §6.3: the transcript lands in the composer as editable draft text.
 * Insertion appends at the cursor or replaces the selection; it is
 * marked un-sent draft like any typed text and is never auto-sent.
 */
export const insertTranscriptIntoDraft = (
    draft: string,
    selectionStart: number,
    selectionEnd: number,
    transcript: string,
): { value: string; cursor: number } => {
    const start = Math.max(0, Math.min(selectionStart, draft.length));
    const end = Math.max(start, Math.min(selectionEnd, draft.length));
    if (!transcript) {
        return { value: draft, cursor: start };
    }
    const value = `${draft.slice(0, start)}${transcript}${draft.slice(end)}`;
    return { value, cursor: start + transcript.length };
};

/**
 * §6.1 recording state machine, identical in both clients:
 * idle → recording → reviewing → submitting → inserted | error, with
 * cancel available in recording and reviewing (discarding the captured
 * audio immediately and locally). Hitting the duration cap stops
 * capture and moves to reviewing — it never auto-submits.
 */
export type VoiceCaptureState = 'idle' | 'recording' | 'reviewing' | 'submitting' | 'inserted' | 'error';

export type VoiceCaptureEvent =
    | { type: 'start_recording' }
    | { type: 'recording_stopped' }
    | { type: 'duration_cap_reached' }
    | { type: 'attach_file' }
    | { type: 'cancel' }
    | { type: 'submit' }
    | { type: 'submit_succeeded' }
    | { type: 'submit_failed' }
    | { type: 'retry' }
    | { type: 'discard' }
    | { type: 'reset' };

export const voiceCaptureReducer = (state: VoiceCaptureState, event: VoiceCaptureEvent): VoiceCaptureState => {
    switch (event.type) {
        case 'reset':
            return 'idle';
        case 'start_recording':
            return state === 'idle' || state === 'inserted' || state === 'error' ? 'recording' : state;
        case 'attach_file':
            // An attached file lands in review, never in an auto-submit (§6.2).
            return state === 'idle' || state === 'inserted' || state === 'error' ? 'reviewing' : state;
        case 'recording_stopped':
        case 'duration_cap_reached':
            return state === 'recording' ? 'reviewing' : state;
        case 'cancel':
            // Cancel discards the captured audio and returns to idle (§6.1).
            return state === 'recording' || state === 'reviewing' ? 'idle' : state;
        case 'submit':
            return state === 'reviewing' ? 'submitting' : state;
        case 'submit_succeeded':
            return state === 'submitting' ? 'inserted' : state;
        case 'submit_failed':
            return state === 'submitting' ? 'error' : state;
        case 'retry':
            // §6.2: in the error state the audio is still held locally;
            // retrying goes back through review so the user re-confirms.
            return state === 'error' ? 'reviewing' : state;
        case 'discard':
            return state === 'reviewing' || state === 'error' || state === 'inserted' ? 'idle' : state;
        default:
            return state;
    }
};

export const canCancelCapture = (state: VoiceCaptureState): boolean => state === 'recording' || state === 'reviewing';

/**
 * Duration to report for a finished recording. A cap-stopped recording is
 * measured after the timer fires, so its raw elapsed time overshoots the
 * cap by the stop latency and §5.2 validation would reject the very clip
 * the cap produced; clamp a cap-stopped recording to the cap itself.
 */
export const recordingDurationSeconds = (startedAtMs: number, nowMs: number, capReached: boolean): number => {
    const measured = Math.max(0, (nowMs - startedAtMs) / 1000);
    return capReached ? Math.min(measured, MAX_AUDIO_DURATION_SECONDS) : measured;
};

/** Seconds left before the §5.2 duration cap stops capture. */
export const recordingSecondsRemaining = (elapsedSeconds: number): number =>
    Math.max(0, MAX_AUDIO_DURATION_SECONDS - Math.max(0, Math.floor(elapsedSeconds)));

/** mm:ss clock for the recording indicator and the cap countdown. */
export const formatClock = (totalSeconds: number): string => {
    const clamped = Math.max(0, Math.floor(totalSeconds));
    const mins = Math.floor(clamped / 60);
    const secs = clamped % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
};
