/**
 * Composer dictation controls: a mic button for the composer footer plus a
 * full-composer overlay while dictation is active (recording, transcribing,
 * or failed). The overlay shows the live partial transcript, a volume meter,
 * a duration timer, and cancel / insert / insert-and-send actions.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { useDictation } from '@/hooks/useDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';

interface ComposerDictationProps {
    radius?: number | string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    disabled?: boolean;
    onInsert: (text: string) => void;
    onInsertAndSend: (text: string) => void;
}

const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
};

const VolumeMeter: React.FC<{ volume: number }> = ({ volume }) => {
    const { currentTheme } = useThemeSystem();
    return (
        <div
            className="h-1.5 w-16 flex-shrink-0 overflow-hidden rounded-full"
            style={{ backgroundColor: currentTheme.colors.interactive.border }}
            aria-hidden="true"
        >
            <div
                className="h-full rounded-full transition-[width] duration-75"
                style={{
                    width: `${Math.round(Math.min(1, volume) * 100)}%`,
                    backgroundColor: currentTheme.colors.primary.base,
                }}
            />
        </div>
    );
};

export const ComposerDictation: React.FC<ComposerDictationProps> = ({
    radius,
    footerIconButtonClass,
    iconSizeClass,
    disabled,
    onInsert,
    onInsertAndSend,
}) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    // The dictation server (WebSocket + STT worker) lives in the OpenChamber
    // web server; the VS Code bridge has no server process for it.
    const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

    const pendingActionRef = React.useRef<'insert' | 'send' | null>(null);
    const onInsertRef = React.useRef(onInsert);
    const onInsertAndSendRef = React.useRef(onInsertAndSend);
    React.useEffect(() => {
        onInsertRef.current = onInsert;
        onInsertAndSendRef.current = onInsertAndSend;
    }, [onInsert, onInsertAndSend]);

    const dictation = useDictation({
        onTranscript: (text) => {
            const action = pendingActionRef.current;
            pendingActionRef.current = null;
            if (action === 'send') {
                onInsertAndSendRef.current(text);
            } else {
                onInsertRef.current(text);
            }
        },
    });

    if (!supported) {
        return null;
    }

    const {
        status,
        partialTranscript,
        volume,
        duration,
        error,
        startDictation,
        confirmDictation,
        cancelDictation,
        retryFailedDictation,
        discardFailedDictation,
    } = dictation;

    const isActive = status !== 'idle';

    const confirmWith = (action: 'insert' | 'send') => {
        pendingActionRef.current = action;
        void confirmDictation();
    };

    const retry = () => {
        pendingActionRef.current = 'insert';
        void retryFailedDictation();
    };

    const overlayButtonClass =
        'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]';

    return (
        <>
            <button
                type="button"
                className={footerIconButtonClass}
                onClick={() => {
                    void startDictation();
                }}
                disabled={disabled || isActive}
                title={t('chat.dictation.start')}
                aria-label={t('chat.dictation.start')}
            >
                <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
            </button>
            {isActive ? (
                <div
                    className="absolute inset-0 z-50 flex flex-col overflow-hidden"
                    style={{
                        borderRadius: radius,
                        backgroundColor: currentTheme.colors.surface.elevated,
                    }}
                    role="dialog"
                    aria-label={t('chat.dictation.overlayAria')}
                >
                    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                        {partialTranscript ? (
                            <p className="typography-body whitespace-pre-wrap" style={{ color: currentTheme.colors.surface.foreground }}>
                                {partialTranscript}
                            </p>
                        ) : (
                            <p className="typography-body" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                                {status === 'recording'
                                    ? t('chat.dictation.listening')
                                    : status === 'uploading'
                                        ? t('chat.dictation.processing')
                                        : ''}
                            </p>
                        )}
                        {status === 'failed' ? (
                            <p className="typography-meta mt-1" style={{ color: currentTheme.colors.status.error }}>
                                {error || t('chat.dictation.failed')}
                            </p>
                        ) : null}
                        {status === 'recording' && error ? (
                            <p className="typography-meta mt-1" style={{ color: currentTheme.colors.status.warning }}>
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-x-3 px-3 pb-2.5">
                        {status === 'recording' ? (
                            <>
                                <span className="relative flex h-2 w-2 flex-shrink-0" aria-hidden="true">
                                    <span
                                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                                        style={{ backgroundColor: currentTheme.colors.status.error }}
                                    />
                                    <span
                                        className="relative inline-flex h-2 w-2 rounded-full"
                                        style={{ backgroundColor: currentTheme.colors.status.error }}
                                    />
                                </span>
                                <VolumeMeter volume={volume} />
                                <span className="typography-meta tabular-nums" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                                    {formatDuration(duration)}
                                </span>
                            </>
                        ) : status === 'uploading' ? (
                            <Icon name="loader-4" className="h-4 w-4 animate-spin" style={{ color: currentTheme.colors.surface.mutedForeground }} />
                        ) : null}
                        <div className="ml-auto flex items-center gap-x-1.5">
                            {status === 'recording' ? (
                                <>
                                    <button
                                        type="button"
                                        className={overlayButtonClass}
                                        onClick={() => {
                                            void cancelDictation();
                                        }}
                                        title={t('chat.dictation.cancel')}
                                        aria-label={t('chat.dictation.cancel')}
                                        style={{ color: currentTheme.colors.surface.mutedForeground }}
                                    >
                                        <Icon name="close" className="h-4.5 w-4.5" />
                                    </button>
                                    <button
                                        type="button"
                                        className={overlayButtonClass}
                                        onClick={() => confirmWith('insert')}
                                        title={t('chat.dictation.insert')}
                                        aria-label={t('chat.dictation.insert')}
                                        style={{ color: currentTheme.colors.surface.foreground }}
                                    >
                                        <Icon name="check" className="h-4.5 w-4.5" />
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
                                        onClick={() => confirmWith('send')}
                                        title={t('chat.dictation.insertAndSend')}
                                        aria-label={t('chat.dictation.insertAndSend')}
                                        style={{
                                            backgroundColor: currentTheme.colors.primary.base,
                                            color: currentTheme.colors.primary.foreground,
                                        }}
                                    >
                                        <Icon name="arrow-up" className="h-4.5 w-4.5" />
                                    </button>
                                </>
                            ) : status === 'uploading' ? (
                                <button
                                    type="button"
                                    className={overlayButtonClass}
                                    onClick={() => {
                                        void cancelDictation();
                                    }}
                                    title={t('chat.dictation.cancel')}
                                    aria-label={t('chat.dictation.cancel')}
                                    style={{ color: currentTheme.colors.surface.mutedForeground }}
                                >
                                    <Icon name="close" className="h-4.5 w-4.5" />
                                </button>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className={overlayButtonClass}
                                        onClick={discardFailedDictation}
                                        title={t('chat.dictation.discard')}
                                        aria-label={t('chat.dictation.discard')}
                                        style={{ color: currentTheme.colors.surface.mutedForeground }}
                                    >
                                        <Icon name="close" className="h-4.5 w-4.5" />
                                    </button>
                                    <button
                                        type="button"
                                        className={overlayButtonClass}
                                        onClick={retry}
                                        title={t('chat.dictation.retry')}
                                        aria-label={t('chat.dictation.retry')}
                                        style={{ color: currentTheme.colors.surface.foreground }}
                                    >
                                        <Icon name="refresh" className="h-4.5 w-4.5" />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
};
