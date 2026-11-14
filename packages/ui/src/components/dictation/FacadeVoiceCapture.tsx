/**
 * Composer voice capture against the opencode STT façade (opencode#1678
 * §8.4, design §6). Two entry points (§6.1): record on OpenChamber's
 * media-permissions path, or attach an existing audio file (§5.1).
 * Captured/file audio is never auto-submitted and never auto-sent
 * (§6.2): the review step offers playback, submit, re-record and
 * discard, surfaces the §5.3 `audio_leaves_machine` notice before
 * submit, and on success the transcript lands in the composer as
 * editable draft text (§6.3) with its provenance shown here.
 *
 * UI strings are plain literals for now: this surface has no locale
 * keys yet, and a missing key would render worse than the literal.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
    DEFAULT_TRANSCRIPTION_MODEL,
    formatClock,
    preSubmitPrivacyNotice,
    recordingSecondsRemaining,
} from '@/lib/dictation/facade-transcription';
import { useFacadeVoiceCapture } from '@/lib/dictation/use-facade-voice-capture';

interface FacadeVoiceCaptureProps {
    footerIconButtonClass: string;
    iconSizeClass: string;
    disabled?: boolean;
    /** §6.3 draft insertion, the same callback the dictation surface uses. */
    onInsert: (text: string) => void;
    /** Marks the dictation origin draft when a capture starts (see the hook). */
    onStart?: () => void;
    model?: string;
}

const ACCEPT_ATTRIBUTE = 'audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac,.aiff';

export const FacadeVoiceCapture: React.FC<FacadeVoiceCaptureProps> = ({
    footerIconButtonClass,
    iconSizeClass,
    disabled,
    onInsert,
    onStart,
    model = DEFAULT_TRANSCRIPTION_MODEL,
}) => {
    const capture = useFacadeVoiceCapture({ onInsert, onStart, model });
    const fileInputRef = React.useRef<HTMLInputElement | null>(null);

    const openFilePicker = React.useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onFileChosen = React.useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) {
                capture.attachFile(file);
            }
        },
        [capture],
    );

    const { state, error, pendingAudio, result } = capture;
    const showReview = (state === 'reviewing' || state === 'submitting' || state === 'error') && pendingAudio;
    const showIdleError = (state === 'idle' || state === 'inserted') && error;
    const provenance = result?.provenance;
    const provenanceLine = provenance
        ? [
              provenance.provider ? `provider ${provenance.provider}` : null,
              provenance.model ? `model ${provenance.model}` : null,
              provenance.durationSeconds !== undefined ? `duration ${formatClock(provenance.durationSeconds)}` : null,
              provenance.language ? `language ${provenance.language}` : null,
          ]
              .filter(Boolean)
              .join(' · ')
        : '';

    return (
        <div className="flex items-center gap-1">
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={onFileChosen} />
            {state === 'idle' || state === 'inserted' ? (
                <>
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        disabled={disabled}
                        onClick={() => void capture.startRecording()}
                        title="Record voice input for the opencode transcription façade"
                        aria-label="Record voice input (transcription façade)"
                    >
                        <Icon name="mic" className={iconSizeClass} />
                    </button>
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        disabled={disabled}
                        onClick={openFilePicker}
                        title="Attach an audio file for transcription"
                        aria-label="Attach an audio file for transcription"
                    >
                        <Icon name="file-music" className={iconSizeClass} />
                    </button>
                </>
            ) : null}

            {state === 'recording' ? (
                <div className="flex items-center gap-2" role="status">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
                    <span className="typography-micro text-muted-foreground">
                        Recording {formatClock(capture.elapsedSeconds)} · cap in {formatClock(recordingSecondsRemaining(capture.elapsedSeconds))}
                    </span>
                    <button type="button" className={footerIconButtonClass} onClick={capture.stopRecording} title="Stop and review" aria-label="Stop recording and review">
                        <Icon name="stop" className={iconSizeClass} />
                    </button>
                    <button type="button" className={footerIconButtonClass} onClick={capture.cancel} title="Cancel and discard" aria-label="Cancel recording and discard audio">
                        <Icon name="close" className={iconSizeClass} />
                    </button>
                </div>
            ) : null}

            {showReview ? (
                <div className="flex max-w-md flex-col gap-1" role="status">
                    <div className="flex items-center gap-2">
                        <span className="typography-micro truncate text-muted-foreground">
                            {pendingAudio.filename}
                            {pendingAudio.durationSeconds !== undefined ? ` · ${formatClock(pendingAudio.durationSeconds)}` : ''}
                        </span>
                        {state === 'reviewing' ? (
                            <>
                                <button type="button" className={footerIconButtonClass} onClick={() => void capture.submit()} title="Submit for transcription" aria-label="Submit audio for transcription">
                                    <Icon name="check" className={iconSizeClass} />
                                </button>
                                <button type="button" className={footerIconButtonClass} onClick={capture.cancel} title="Discard audio" aria-label="Discard audio">
                                    <Icon name="delete-bin" className={iconSizeClass} />
                                </button>
                            </>
                        ) : null}
                        {state === 'submitting' ? <Icon name="loader-4" className={cn(iconSizeClass, 'animate-spin')} /> : null}
                        {state === 'error' ? (
                            <>
                                <button type="button" className={footerIconButtonClass} onClick={capture.retry} title="Back to review (audio kept)" aria-label="Back to review">
                                    <Icon name="play" className={iconSizeClass} />
                                </button>
                                <button type="button" className={footerIconButtonClass} onClick={capture.discard} title="Discard audio" aria-label="Discard audio">
                                    <Icon name="delete-bin" className={iconSizeClass} />
                                </button>
                            </>
                        ) : null}
                    </div>
                    <audio controls src={pendingAudio.url} className="h-8 w-full" />
                    {state === 'reviewing' ? (
                        <p className="typography-micro text-muted-foreground">{preSubmitPrivacyNotice(model)}</p>
                    ) : null}
                    {state === 'submitting' ? (
                        <p className="typography-micro text-muted-foreground">Transcribing…</p>
                    ) : null}
                    {state === 'error' && error ? (
                        <p className="typography-micro text-destructive" role="alert">
                            {error.message}
                            {error.retryable ? ' You can retry — the audio is still held locally.' : ''}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {showIdleError ? (
                <p className="typography-micro max-w-xs text-destructive" role="alert">
                    {error.message}{' '}
                    {error.code === 'permission_denied' ? (
                        <button type="button" className="underline" onClick={openFilePicker}>
                            Attach an audio file
                        </button>
                    ) : null}
                </p>
            ) : null}

            {state === 'inserted' && result ? (
                <span className="typography-micro text-muted-foreground" role="status">
                    Transcript inserted as draft{provenanceLine ? ` (${provenanceLine})` : ''}.{' '}
                    <button type="button" className="underline" onClick={capture.discard}>
                        Done
                    </button>
                </span>
            ) : null}
        </div>
    );
};
