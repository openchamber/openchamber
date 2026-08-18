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
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';

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
    /** Reports whether dictation is active (recording/transcribing/failed overlay shown). */
    onActiveChange?: (active: boolean) => void;
    /** Reports the height (px) the transcript needs, so the host can grow the
        composer like typed text would; null when dictation is idle. */
    onContentHeightChange?: (height: number | null) => void;
    /** Render the mic trigger button (default). Pass false when the host renders
        its own trigger and only needs the overlay + recording engine. */
    renderTrigger?: boolean;
    /** Rendered at the very top of the active overlay (e.g. the mobile composer
        drag handle, so swipe-expand keeps working in Listening mode). */
    topAccessory?: React.ReactNode;
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
    onActiveChange,
    onContentHeightChange,
    renderTrigger = true,
    topAccessory,
}) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const dictationShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides));
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

    const statusRef = React.useRef(status);
    React.useEffect(() => {
        statusRef.current = status;
    }, [status]);

    // Layout effect on purpose: the host may expand/collapse the composer in
    // response, and that state change must land in the same paint as the
    // overlay (a plain effect painted one clipped frame of overlay content
    // inside the still-collapsed pill before the morph started).
    React.useLayoutEffect(() => {
        onActiveChange?.(status !== 'idle');
    }, [status, onActiveChange]);

    // Keyboard shortcut (toggle_dictation): idle -> start recording,
    // recording -> confirm and insert. Dispatched by useKeyboardShortcuts.
    React.useEffect(() => {
        const onToggle = () => {
            if (statusRef.current === 'idle') {
                void startDictation();
            } else if (statusRef.current === 'recording') {
                pendingActionRef.current = 'insert';
                void confirmDictation();
            }
        };
        window.addEventListener('openchamber:dictation-toggle', onToggle);
        return () => window.removeEventListener('openchamber:dictation-toggle', onToggle);
    }, [startDictation, confirmDictation]);

    // While recording: Enter confirms (insert), Escape cancels. Capture-phase
    // so the composer's own Enter-to-send never fires underneath the overlay.
    React.useEffect(() => {
        if (status !== 'recording') {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.isComposing) {
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                pendingActionRef.current = 'insert';
                void confirmDictation();
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                void cancelDictation();
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [status, confirmDictation, cancelDictation]);

    // Pixel-parity with the composer: the real footer row is taller than our
    // buttons (its height comes from the tallest control, e.g. the model
    // picker), so measure it — it stays mounted underneath the overlay — and
    // give our action row the same height so the icons line up exactly.
    const overlayRef = React.useRef<HTMLDivElement | null>(null);
    const transcriptAreaRef = React.useRef<HTMLDivElement | null>(null);
    const transcriptContentRef = React.useRef<HTMLDivElement | null>(null);
    const [footerHeight, setFooterHeight] = React.useState<number | null>(null);
    const isActiveStatus = status !== 'idle';

    // Grow the composer with the transcript, the way typing grows the
    // textarea. The overlay is absolutely positioned over the composer, so it
    // can't push the composer's height itself — measure how much room the
    // transcript wants (scrollHeight ignores the clamped box) and report it to
    // the host, which feeds it into the textarea autosize (same line cap, then
    // the transcript area scrolls).
    const onContentHeightChangeRef = React.useRef(onContentHeightChange);
    React.useEffect(() => {
        onContentHeightChangeRef.current = onContentHeightChange;
    }, [onContentHeightChange]);
    // Two instances can coexist (mobile footer + wrapper engine); only the one
    // that actually reported a height may clear it, or an idle sibling
    // mounting mid-recording would zero the active transcript's height.
    const hasReportedHeightRef = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!isActiveStatus) {
            if (hasReportedHeightRef.current) {
                hasReportedHeightRef.current = false;
                onContentHeightChangeRef.current?.(null);
            }
            return;
        }
        const area = transcriptAreaRef.current;
        const content = transcriptContentRef.current;
        if (!area || !content) return;
        // Measure the text block, not the container: the container is flex-1
        // inside the overlay, so its scrollHeight tracks the composer's own
        // height — feeding that back would creep a few px on every transcript
        // update instead of stepping per wrapped line.
        const style = window.getComputedStyle(area);
        const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        hasReportedHeightRef.current = true;
        onContentHeightChangeRef.current?.(content.offsetHeight + padding);
        // Once the composer hits its line cap the transcript area starts
        // scrolling — follow the newest words like a textarea caret would.
        area.scrollTop = area.scrollHeight;
    }, [isActiveStatus, partialTranscript, status, error]);
    React.useEffect(() => () => {
        if (hasReportedHeightRef.current) {
            hasReportedHeightRef.current = false;
            onContentHeightChangeRef.current?.(null);
        }
    }, []);
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

    // Dictation must not dismiss the soft keyboard: block the focus transfer
    // iOS performs on tap for the mic and every overlay control (same pattern
    // as PermissionAutoAcceptButton).
    const keepKeyboardFocusProps = {
        onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
        onPointerDownCapture: (event: React.PointerEvent) => {
            if (event.pointerType === 'touch') {
                event.preventDefault();
            }
        },
    } as const;

    return (
        <>
            {renderTrigger ? (
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className={footerIconButtonClass}
                    onClick={() => {
                        void startDictation();
                    }}
                    disabled={disabled || isActive}
                    title={dictationShortcut ? `${t('chat.dictation.start')} (${dictationShortcut})` : t('chat.dictation.start')}
                    aria-label={t('chat.dictation.start')}
                >
                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
            {isActive ? (
                <div
                    ref={overlayRef}
                    // overflow-x/y split on purpose: mobile.css rewrites the
                    // shorthand `.overflow-hidden` to overflow-y:auto on touch
                    // devices, which painted a phantom scrollbar on Android.
                    className={cn(
                        'absolute inset-0 z-50 flex flex-col overflow-x-hidden overflow-y-hidden',
                        // Mobile: the overlay surface shows instantly (riding the
                        // pill → voice morph), its content fades in only after the
                        // shape has grown — otherwise the controls paint clipped
                        // inside the still-small pill.
                        isMobile && 'oc-composer-morph-content-fade',
                    )}
                    style={{
                        borderRadius: radius,
                        // Must match the composer box background exactly so the
                        // overlay reads as the same surface, not a layer on top.
                        backgroundColor: currentTheme.colors.surface.subtle,
                    }}
                    role="dialog"
                    aria-label={t('chat.dictation.overlayAria')}
                >
                    {topAccessory}
                    <div
                        ref={transcriptAreaRef}
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
                        {/* Measured for the composer-growth report — keep all
                            transcript/placeholder/error content inside. */}
                        <div ref={transcriptContentRef}>
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
                                        {...keepKeyboardFocusProps}
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
                                        {...keepKeyboardFocusProps}
                                        className={footerIconButtonClass}
                                        onClick={() => confirmWith('insert')}
                                        title={t('chat.dictation.insert')}
                                        aria-label={t('chat.dictation.insert')}
                                    >
                                        <Icon name="check" className={iconSizeClass} />
                                    </button>
                                    <button
                                        type="button"
                                        {...keepKeyboardFocusProps}
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
                                    {...keepKeyboardFocusProps}
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
                                        {...keepKeyboardFocusProps}
                                        className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                                        onClick={discardFailedDictation}
                                        title={t('chat.dictation.discard')}
                                        aria-label={t('chat.dictation.discard')}
                                    >
                                        <Icon name="close" className={iconSizeClass} />
                                    </button>
                                    <button
                                        type="button"
                                        {...keepKeyboardFocusProps}
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
                                            {...keepKeyboardFocusProps}
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
