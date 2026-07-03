/**
 * Composer dictation controls: a mic button for the composer footer plus a
 * full-composer overlay while dictation is active (recording, transcribing,
 * or failed). The overlay mirrors the composer's own layout — the transcript
 * area uses the same paddings/typography as the textarea and the action row
 * reuses the footer icon-button styling — so toggling dictation causes no
 * vertical shift.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDictation } from '@/hooks/useDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useConfigStore } from '@/stores/useConfigStore';

interface ComposerDictationProps {
    radius?: number | string;
    isMobile: boolean;
    footerIconButtonClass: string;
    footerPaddingClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
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

/**
 * Polls the dictation status route while the local model is downloading and
 * returns the download percent (null while unknown / not downloading).
 */
const useModelDownloadProgress = (active: boolean): number | null => {
    const sttLocalModel = useConfigStore((state) => state.sttLocalModel);
    const [percent, setPercent] = React.useState<number | null>(null);

    React.useEffect(() => {
        if (!active) {
            setPercent(null);
            return;
        }
        let cancelled = false;
        const poll = async () => {
            try {
                const response = await runtimeFetch('/api/dictation/status', {
                    query: { provider: 'local', localModel: sttLocalModel },
                });
                if (!response.ok || cancelled) {
                    return;
                }
                const data = await response.json();
                const model = Array.isArray(data?.models)
                    ? data.models.find((m: { id: string }) => m.id === sttLocalModel)
                    : null;
                if (!cancelled) {
                    setPercent(typeof model?.downloadProgress === 'number' ? model.downloadProgress : null);
                }
            } catch {
                // Display-only; keep the previous value.
            }
        };
        void poll();
        const interval = setInterval(() => {
            void poll();
        }, 2000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [active, sttLocalModel]);

    return active ? percent : null;
};

export const ComposerDictation: React.FC<ComposerDictationProps> = ({
    radius,
    isMobile,
    footerIconButtonClass,
    footerPaddingClass,
    iconSizeClass,
    sendIconSizeClass,
    disabled,
    onInsert,
    onInsertAndSend,
}) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
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

    const {
        status,
        partialTranscript,
        volume,
        duration,
        error,
        errorReason,
        startDictation,
        confirmDictation,
        cancelDictation,
        retryFailedDictation,
        acceptPartialTranscript,
        discardFailedDictation,
    } = dictation;

    const isModelDownloading = status === 'recording' && errorReason === 'model_download_in_progress';
    const downloadPercent = useModelDownloadProgress(isModelDownloading);

    // Pixel-parity with the composer: the real footer row is taller than our
    // buttons (its height comes from the tallest control, e.g. the model
    // picker), so measure it — it stays mounted underneath the overlay — and
    // give our action row the same height so the icons line up exactly.
    const overlayRef = React.useRef<HTMLDivElement | null>(null);
    const [footerHeight, setFooterHeight] = React.useState<number | null>(null);
    const isActiveStatus = status !== 'idle';
    React.useLayoutEffect(() => {
        if (!isActiveStatus) {
            return;
        }
        // The overlay is rendered inside the composer footer itself, so the
        // real footer is an ancestor, not a sibling.
        const realFooter = overlayRef.current?.closest<HTMLElement>('[data-chat-input-footer="true"]');
        if (realFooter && realFooter.offsetHeight > 0) {
            setFooterHeight(realFooter.offsetHeight);
        }
    }, [isActiveStatus]);

    if (!supported || !dictationEnabled) {
        return null;
    }

    const isActive = status !== 'idle';

    const confirmWith = (action: 'insert' | 'send') => {
        pendingActionRef.current = action;
        void confirmDictation();
    };

    const retry = () => {
        pendingActionRef.current = 'insert';
        void retryFailedDictation();
    };

    const placeholderText = (() => {
        if (status === 'failed') {
            return '';
        }
        if (status === 'uploading') {
            return t('chat.dictation.processing');
        }
        if (isModelDownloading) {
            return downloadPercent !== null
                ? t('chat.dictation.downloadingModelProgress', { percent: String(downloadPercent) })
                : t('chat.dictation.downloadingModel');
        }
        return t('chat.dictation.listening');
    })();

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
                    ref={overlayRef}
                    // overflow-x/y split on purpose: mobile.css rewrites the
                    // shorthand `.overflow-hidden` to overflow-y:auto on touch
                    // devices, which painted a phantom scrollbar on Android.
                    className="absolute inset-0 z-50 flex flex-col overflow-x-hidden overflow-y-hidden"
                    style={{
                        borderRadius: radius,
                        // Must match the composer box background exactly so the
                        // overlay reads as the same surface, not a layer on top.
                        backgroundColor: currentTheme.colors.surface.subtle,
                    }}
                    role="dialog"
                    aria-label={t('chat.dictation.overlayAria')}
                >
                    <div
                        className={cn(
                            // Text paddings match the composer textarea, plus the
                            // 4px (pt-1) attachment-chips row that always renders
                            // above it: desktop 16+4px, mobile 10+4px from the top.
                            // min-h-0 (not a fixed min height): the mobile composer
                            // is shorter than 52px of text area + footer, and a
                            // fixed min pushed the action row 4px below the real
                            // footer. The area must shrink to whatever space the
                            // underlying composer actually has.
                            'flex-1 min-h-0 overflow-y-auto px-3',
                            isMobile ? 'pt-3.5 pb-2.5' : 'pt-5 pb-2',
                        )}
                    >
                        {partialTranscript ? (
                            <p className="typography-markdown md:typography-ui-label whitespace-pre-wrap" style={{ color: currentTheme.colors.surface.foreground }}>
                                {partialTranscript}
                            </p>
                        ) : (
                            <p className="typography-markdown md:typography-ui-label" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                                {placeholderText}
                            </p>
                        )}
                        {status === 'failed' ? (
                            <p className="typography-meta mt-1" style={{ color: currentTheme.colors.status.error }}>
                                {error || t('chat.dictation.failed')}
                            </p>
                        ) : null}
                        {status === 'recording' && error && !isModelDownloading ? (
                            <p className="typography-meta mt-1" style={{ color: currentTheme.colors.status.warning }}>
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <div
                        className={cn('flex flex-shrink-0 items-center gap-x-3', footerPaddingClass)}
                        style={footerHeight ? { height: footerHeight } : undefined}
                    >
                        {status === 'recording' ? (
                            <>
                                <span className="relative ml-1 flex h-2 w-2 flex-shrink-0" aria-hidden="true">
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
                            <Icon name="loader-4" className="ml-1 h-4 w-4 animate-spin" style={{ color: currentTheme.colors.surface.mutedForeground }} />
                        ) : null}
                        {/* Same inter-control gap as the composer's right cluster:
                            gap-x-1 on mobile, md:gap-x-3 on desktop. */}
                        <div className={cn('ml-auto flex items-center', isMobile ? 'gap-x-1' : 'gap-x-1.5 md:gap-x-3')}>
                            {status === 'recording' ? (
                                <>
                                    <button
                                        type="button"
                                        className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                                        onClick={() => {
                                            void cancelDictation();
                                        }}
                                        title={t('chat.dictation.cancel')}
                                        aria-label={t('chat.dictation.cancel')}
                                    >
                                        <Icon name="close" className={iconSizeClass} />
                                    </button>
                                    <button
                                        type="button"
                                        className={footerIconButtonClass}
                                        onClick={() => confirmWith('insert')}
                                        title={t('chat.dictation.insert')}
                                        aria-label={t('chat.dictation.insert')}
                                    >
                                        <Icon name="check" className={iconSizeClass} />
                                    </button>
                                    <button
                                        type="button"
                                        className={cn(footerIconButtonClass, 'text-primary hover:text-primary')}
                                        onClick={() => confirmWith('send')}
                                        title={t('chat.dictation.insertAndSend')}
                                        aria-label={t('chat.dictation.insertAndSend')}
                                    >
                                        <Icon name="send-plane-2" className={sendIconSizeClass} />
                                    </button>
                                </>
                            ) : status === 'uploading' ? (
                                <button
                                    type="button"
                                    className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                                    onClick={() => {
                                        void cancelDictation();
                                    }}
                                    title={t('chat.dictation.cancel')}
                                    aria-label={t('chat.dictation.cancel')}
                                >
                                    <Icon name="close" className={iconSizeClass} />
                                </button>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                                        onClick={discardFailedDictation}
                                        title={t('chat.dictation.discard')}
                                        aria-label={t('chat.dictation.discard')}
                                    >
                                        <Icon name="close" className={iconSizeClass} />
                                    </button>
                                    <button
                                        type="button"
                                        className={footerIconButtonClass}
                                        onClick={retry}
                                        title={t('chat.dictation.retry')}
                                        aria-label={t('chat.dictation.retry')}
                                    >
                                        <Icon name="refresh" className={iconSizeClass} />
                                    </button>
                                    {partialTranscript.trim() ? (
                                        <button
                                            type="button"
                                            className={footerIconButtonClass}
                                            onClick={() => {
                                                pendingActionRef.current = 'insert';
                                                acceptPartialTranscript();
                                            }}
                                            title={t('chat.dictation.insert')}
                                            aria-label={t('chat.dictation.insert')}
                                        >
                                            <Icon name="check" className={iconSizeClass} />
                                        </button>
                                    ) : null}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
};
