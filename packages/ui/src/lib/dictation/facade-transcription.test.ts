import { describe, expect, test } from 'bun:test';

import {
    FacadeTranscriptionError,
    MAX_AUDIO_BYTES,
    audioLeavesMachine,
    buildTranscriptionFormData,
    buildTranscriptionUrl,
    canCancelCapture,
    formatClock,
    insertTranscriptIntoDraft,
    isAcceptedAudioMediaType,
    parseFacadeError,
    parseTranscriptionEnvelope,
    preSubmitPrivacyNotice,
    recordingDurationSeconds,
    recordingSecondsRemaining,
    transcribeViaFacade,
    validateAudioInput,
    voiceCaptureReducer,
    type TranscriptionFetch,
    type VoiceCaptureState,
} from './facade-transcription';

describe('buildTranscriptionUrl', () => {
    test('derives the server root from the /api mount, mirroring the opencode client', () => {
        expect(buildTranscriptionUrl('/api')).toBe('/v1/audio/transcriptions');
        expect(buildTranscriptionUrl('/api/')).toBe('/v1/audio/transcriptions');
        expect(buildTranscriptionUrl('http://localhost:4096')).toBe('http://localhost:4096/v1/audio/transcriptions');
        expect(buildTranscriptionUrl('https://host.example/api')).toBe('https://host.example/v1/audio/transcriptions');
        expect(buildTranscriptionUrl('/')).toBe('/v1/audio/transcriptions');
    });
});

describe('recordingDurationSeconds', () => {
    test('reports the measured duration for a manual stop', () => {
        expect(recordingDurationSeconds(1_000, 61_000, false)).toBe(60);
    });

    test('clamps a cap-stopped recording to the cap so §5.2 validation accepts it', () => {
        // The cap timer fires at 600s; the recorder stop lands later, so the
        // raw measurement overshoots — the reported duration must not.
        expect(recordingDurationSeconds(0, 600_400, true)).toBe(600);
        expect(validateAudioInput({ sizeBytes: 1024, mediaType: 'audio/webm', durationSeconds: recordingDurationSeconds(0, 600_400, true) })).toBeNull();
    });

    test('does not clamp a manually stopped recording', () => {
        expect(recordingDurationSeconds(0, 600_400, false)).toBe(600.4);
    });
});

describe('validateAudioInput (§5.2 caps)', () => {
    test('accepts an in-caps webm recording', () => {
        expect(validateAudioInput({ sizeBytes: 1024, mediaType: 'audio/webm', durationSeconds: 12 })).toBeNull();
    });

    test('rejects empty audio as invalid_audio', () => {
        const error = validateAudioInput({ sizeBytes: 0, mediaType: 'audio/webm' });
        expect(error?.code).toBe('invalid_audio');
    });

    test('rejects an unaccepted container as unsupported_media_type', () => {
        const error = validateAudioInput({ sizeBytes: 1024, mediaType: 'video/mp4', filename: 'clip.mp4' });
        expect(error?.code).toBe('unsupported_media_type');
    });

    test('falls back to the file extension when no media type is reported', () => {
        expect(isAcceptedAudioMediaType('', 'voice.wav')).toBe(true);
        expect(isAcceptedAudioMediaType('application/octet-stream', 'voice.m4a')).toBe(true);
        expect(isAcceptedAudioMediaType('', 'notes.txt')).toBe(false);
    });

    test('rejects over-size audio as audio_too_large without truncating', () => {
        const error = validateAudioInput({ sizeBytes: MAX_AUDIO_BYTES + 1, mediaType: 'audio/wav' });
        expect(error?.code).toBe('audio_too_large');
    });

    test('rejects over-cap duration as duration_too_long', () => {
        const error = validateAudioInput({ sizeBytes: 1024, mediaType: 'audio/wav', durationSeconds: 601 });
        expect(error?.code).toBe('duration_too_long');
        expect(validateAudioInput({ sizeBytes: 1024, mediaType: 'audio/wav', durationSeconds: 600 })).toBeNull();
    });
});

describe('audioLeavesMachine / preSubmitPrivacyNotice (§5.3)', () => {
    test('every phase-1 registered ref is hosted, so audio leaves the machine', () => {
        expect(audioLeavesMachine('openai/whisper-1')).toBe(true);
        expect(audioLeavesMachine('deepgram/nova-3')).toBe(true);
    });

    test('the notice names the model and the retention consequence before submit', () => {
        const notice = preSubmitPrivacyNotice('openai/whisper-1');
        expect(notice).toContain('openai/whisper-1');
        expect(notice).toContain('Audio leaves this machine');
        expect(notice).toContain('retention policy');
    });
});

describe('parseTranscriptionEnvelope (§2.3)', () => {
    test('parses a full envelope with provenance from provider_metadata', () => {
        const result = parseTranscriptionEnvelope({
            text: 'hello world',
            language: 'en',
            duration: 12.4,
            segments: [{ text: 'hello world', start: 0, end: 4.2, speaker: 'A' }],
            words: [{ word: 'hello', start: 0, end: 0.3, confidence: 0.98 }],
            usage: { type: 'seconds', seconds: 12.4 },
            notices: [],
            provider_metadata: { provider: 'deepgram', model: 'nova-3' },
        });
        expect(result.text).toBe('hello world');
        expect(result.language).toBe('en');
        expect(result.durationSeconds).toBe(12.4);
        expect(result.segments).toEqual([{ text: 'hello world', start: 0, end: 4.2, speaker: 'A' }]);
        expect(result.words).toEqual([{ word: 'hello', start: 0, end: 0.3, confidence: 0.98 }]);
        expect(result.provenance).toEqual({ provider: 'deepgram', model: 'nova-3', durationSeconds: 12.4, language: 'en' });
    });

    test('absence means not reported: optional fields stay absent, never fabricated', () => {
        const result = parseTranscriptionEnvelope({ text: 'bare', notices: [] });
        expect(result.text).toBe('bare');
        expect(result.language).toBeUndefined();
        expect(result.durationSeconds).toBeUndefined();
        expect(result.segments).toBeUndefined();
        expect(result.provenance).toEqual({});
    });

    test('a response without text is an invalid_response error', () => {
        expect(() => parseTranscriptionEnvelope({ notices: [] })).toThrow(FacadeTranscriptionError);
        try {
            parseTranscriptionEnvelope(null);
        } catch (error) {
            expect((error as FacadeTranscriptionError).code).toBe('invalid_response');
        }
    });
});

describe('parseFacadeError (§2.4)', () => {
    test('uses the body code and message when present', () => {
        const error = parseFacadeError(404, { error: { message: 'no such model', type: 'invalid_request_error', code: 'model_not_found' } });
        expect(error.code).toBe('model_not_found');
        expect(error.message).toBe('no such model');
        expect(error.status).toBe(404);
        expect(error.retryable).toBe(false);
    });

    test('maps statuses when the body carries no usable code', () => {
        expect(parseFacadeError(401, null).code).toBe('unauthenticated');
        expect(parseFacadeError(413, null).code).toBe('audio_too_large');
        expect(parseFacadeError(429, {}).code).toBe('rate_limit');
        expect(parseFacadeError(429, {}).retryable).toBe(true);
        expect(parseFacadeError(502, {}).code).toBe('upstream_failure');
        expect(parseFacadeError(400, {}).code).toBe('invalid_audio');
    });

    test('preserves a quota code from the body', () => {
        const error = parseFacadeError(429, { error: { message: 'quota', type: 'rate_limit_error', code: 'quota_exceeded' } });
        expect(error.code).toBe('quota_exceeded');
        expect(error.retryable).toBe(true);
    });
});

describe('buildTranscriptionFormData (§2.2)', () => {
    test('sends file + model + json response format, language only when given', () => {
        const form = buildTranscriptionFormData(new Blob(['x'], { type: 'audio/webm' }), 'clip.webm', { language: 'en' });
        expect(form.get('model')).toBe('openai/whisper-1');
        expect(form.get('response_format')).toBe('json');
        expect(form.get('language')).toBe('en');
        const file = form.get('file') as File;
        expect(file.name).toBe('clip.webm');
        expect(file.type).toBe('audio/webm');
    });

    test('omits language and honors an explicit model ref', () => {
        const form = buildTranscriptionFormData(new Blob(['x']), 'a.wav', { model: 'deepgram/nova-3' });
        expect(form.get('model')).toBe('deepgram/nova-3');
        expect(form.get('language')).toBeNull();
    });
});

describe('transcribeViaFacade', () => {
    const okFetch =
        (payload: unknown): TranscriptionFetch =>
        async () => ({ ok: true, status: 200, json: async () => payload });

    test('posts once to the façade URL and returns the parsed envelope', async () => {
        let seenUrl = '';
        let seenMethod = '';
        const fetchFn: TranscriptionFetch = async (url, init) => {
            seenUrl = url;
            seenMethod = init.method;
            return { ok: true, status: 200, json: async () => ({ text: 'hi', provider_metadata: { provider: 'openai', model: 'whisper-1' } }) };
        };
        const result = await transcribeViaFacade({
            fetchFn,
            url: 'http://localhost:4096/v1/audio/transcriptions',
            file: new Blob(['audio'], { type: 'audio/webm' }),
            filename: 'clip.webm',
        });
        expect(seenUrl).toBe('http://localhost:4096/v1/audio/transcriptions');
        expect(seenMethod).toBe('POST');
        expect(result.text).toBe('hi');
        expect(result.provenance.provider).toBe('openai');
        void okFetch;
    });

    const expectFacadeRejection = async (
        promise: Promise<unknown>,
        code: string,
        extras: { status?: number; retryable?: boolean } = {},
    ): Promise<void> => {
        try {
            await promise;
        } catch (error) {
            expect(error).toBeInstanceOf(FacadeTranscriptionError);
            const facadeError = error as FacadeTranscriptionError;
            expect(facadeError.code).toBe(code);
            if (extras.status !== undefined) {
                expect(facadeError.status).toBe(extras.status);
            }
            if (extras.retryable !== undefined) {
                expect(facadeError.retryable).toBe(extras.retryable);
            }
            return;
        }
        throw new Error(`expected a FacadeTranscriptionError with code ${code}`);
    };

    test('validates caps before any network call', async () => {
        let calls = 0;
        const fetchFn: TranscriptionFetch = async () => {
            calls += 1;
            return { ok: true, status: 200, json: async () => ({ text: 'x' }) };
        };
        await expectFacadeRejection(
            transcribeViaFacade({
                fetchFn,
                url: 'http://x/v1/audio/transcriptions',
                file: new Blob(['audio'], { type: 'video/mp4' }),
                filename: 'clip.mp4',
            }),
            'unsupported_media_type',
        );
        expect(calls).toBe(0);
    });

    test('maps a façade error envelope to a typed error', async () => {
        const fetchFn: TranscriptionFetch = async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: { message: 'bad codec', type: 'invalid_request_error', code: 'unsupported_media_type' } }),
        });
        await expectFacadeRejection(
            transcribeViaFacade({
                fetchFn,
                url: 'http://x/v1/audio/transcriptions',
                file: new Blob(['audio'], { type: 'audio/webm' }),
                filename: 'clip.webm',
            }),
            'unsupported_media_type',
            { status: 400 },
        );
    });

    test('a transport failure is a retryable network_error', async () => {
        const fetchFn: TranscriptionFetch = async () => {
            throw new Error('socket closed');
        };
        await expectFacadeRejection(
            transcribeViaFacade({
                fetchFn,
                url: 'http://x/v1/audio/transcriptions',
                file: new Blob(['audio'], { type: 'audio/webm' }),
                filename: 'clip.webm',
            }),
            'network_error',
            { retryable: true },
        );
    });
});

describe('insertTranscriptIntoDraft (§6.3)', () => {
    test('appends at the cursor', () => {
        expect(insertTranscriptIntoDraft('hello ', 6, 6, 'world')).toEqual({ value: 'hello world', cursor: 11 });
    });

    test('replaces the selection', () => {
        expect(insertTranscriptIntoDraft('say OLD now', 4, 7, 'new')).toEqual({ value: 'say new now', cursor: 7 });
    });

    test('clamps out-of-range selections and ignores an empty transcript', () => {
        expect(insertTranscriptIntoDraft('abc', 99, 99, 'd')).toEqual({ value: 'abcd', cursor: 4 });
        expect(insertTranscriptIntoDraft('abc', 1, 2, '')).toEqual({ value: 'abc', cursor: 1 });
    });
});

describe('voiceCaptureReducer (§6.1 state machine)', () => {
    const run = (from: VoiceCaptureState, events: Array<Parameters<typeof voiceCaptureReducer>[1]['type']>) =>
        events.reduce<VoiceCaptureState>((state, type) => voiceCaptureReducer(state, { type } as never), from);

    test('happy path: record → review → submit → inserted', () => {
        expect(run('idle', ['start_recording', 'recording_stopped', 'submit', 'submit_succeeded'])).toBe('inserted');
    });

    test('attach lands in reviewing, never auto-submits', () => {
        expect(run('idle', ['attach_file'])).toBe('reviewing');
    });

    test('duration cap stops capture into reviewing, not submitting', () => {
        expect(run('recording', ['duration_cap_reached'])).toBe('reviewing');
    });

    test('cancel is available in recording and reviewing only', () => {
        expect(run('recording', ['cancel'])).toBe('idle');
        expect(run('reviewing', ['cancel'])).toBe('idle');
        expect(canCancelCapture('recording')).toBe(true);
        expect(canCancelCapture('reviewing')).toBe(true);
        expect(canCancelCapture('submitting')).toBe(false);
        expect(run('submitting', ['cancel'])).toBe('submitting');
    });

    test('a failed submit lands in error; retry returns to review with audio held; discard goes idle', () => {
        expect(run('submitting', ['submit_failed'])).toBe('error');
        expect(run('error', ['retry'])).toBe('reviewing');
        expect(run('error', ['discard'])).toBe('idle');
    });

    test('invalid transitions are ignored', () => {
        expect(run('idle', ['submit'])).toBe('idle');
        expect(run('idle', ['recording_stopped'])).toBe('idle');
        expect(run('reviewing', ['start_recording'])).toBe('reviewing');
    });
});

describe('recording clock helpers', () => {
    test('formatClock renders mm:ss', () => {
        expect(formatClock(0)).toBe('0:00');
        expect(formatClock(65)).toBe('1:05');
        expect(formatClock(600)).toBe('10:00');
    });

    test('recordingSecondsRemaining counts down to the cap and floors at zero', () => {
        expect(recordingSecondsRemaining(0)).toBe(600);
        expect(recordingSecondsRemaining(599)).toBe(1);
        expect(recordingSecondsRemaining(900)).toBe(0);
    });
});
