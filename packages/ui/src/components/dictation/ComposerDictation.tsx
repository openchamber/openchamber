import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDictation } from '@/hooks/useDictation';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

let recordingOwner: HTMLSpanElement | null = null;

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
    onStart?: () => void;
    onSendStart?: () => void;
    onActiveChange?: (active: boolean) => void;
    onContentHeightChange?: (height: number | null) => void;
    renderTrigger?: boolean;
    topAccessory?: React.ReactNode;
}

const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
};

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
                const modelId = data?.activeModel ?? sttLocalModel;
                const model = Array.isArray(data?.models)
                    ? data.models.find((m: { id: string }) => m.id === modelId)
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
    onStart,
    onSendStart,
    onActiveChange,
    onContentHeightChange,
    renderTrigger = true,
    topAccessory,
}) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const dictationAutoSend = useConfigStore((state) => state.dictationAutoSend);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const dictationShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), '');
    const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

    const pendingActionRef = React.useRef<'insert' | 'send' | null>(null);
    const composerMarkerRef = React.useRef<HTMLSpanElement | null>(null);
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
    } = dictation;
    const recordingBlink = useWaitingBlink(status === 'recording');

    const isModelDownloading = status === 'recording' && errorReason === 'model_download_in_progress';
    const downloadPercent = useModelDownloadProgress(isModelDownloading);

    const statusRef = React.useRef(status);
    React.useLayoutEffect(() => {
        statusRef.current = status;
        if (status === 'idle' && recordingOwner === composerMarkerRef.current) {
            recordingOwner = null;
        }
    });

    const startRecording = React.useCallback(() => {
        if (!supported || !dictationEnabled || disabled || recordingOwner || statusRef.current !== 'idle') return;
        recordingOwner = composerMarkerRef.current;
        void startDictation();
    }, [supported, dictationEnabled, disabled, startDictation]);

    const onStartRef = React.useRef(onStart);
    React.useEffect(() => {
        onStartRef.current = onStart;
    }, [onStart]);
    const onSendStartRef = React.useRef(onSendStart);
    React.useEffect(() => {
        onSendStartRef.current = onSendStart;
    }, [onSendStart]);

    const confirmWith = React.useCallback((action: 'insert' | 'send') => {
        pendingActionRef.current = action;
        if (action === 'send') {
            onSendStartRef.current?.();
        }
        void confirmDictation();
    }, [confirmDictation]);

    const wasIdleRef = React.useRef(true);
    React.useLayoutEffect(() => {
        const idle = status === 'idle';
        if (wasIdleRef.current && !idle) {
            onStartRef.current?.();
        }
        wasIdleRef.current = idle;
    }, [status]);

    React.useLayoutEffect(() => {
        onActiveChange?.(status !== 'idle');
    }, [status, onActiveChange]);

    React.useEffect(() => {
        if (!supported || !dictationEnabled) return;
        const marker = composerMarkerRef.current;
        const onToggle = (event: Event) => {
            const requestedForm = (event as CustomEvent<{ composer?: HTMLFormElement }>).detail?.composer;
            if (requestedForm && (!marker || !requestedForm.contains(marker))) return;
            const targetForm = requestedForm
                ?? document.activeElement?.closest('form')
                ?? Array.from(document.querySelectorAll('[data-composer-dictation]'))
                    .find((element) => !element.closest('[data-chat-column="pinned"]'))?.closest('form');
            if (recordingOwner ? recordingOwner !== marker : !marker || !targetForm?.contains(marker)) return;
            event.stopImmediatePropagation();
            if (statusRef.current === 'idle') {
                startRecording();
            } else if (statusRef.current === 'recording') {
                confirmWith(dictationAutoSend ? 'send' : 'insert');
            }
        };
        window.addEventListener('openchamber:dictation-toggle', onToggle);
        return () => window.removeEventListener('openchamber:dictation-toggle', onToggle);
    }, [supported, dictationEnabled, startRecording, confirmWith, dictationAutoSend]);

    React.useEffect(() => {
        const marker = composerMarkerRef.current;
        return () => {
            if (recordingOwner === marker) recordingOwner = null;
        };
    }, [supported, dictationEnabled]);

    React.useEffect(() => {
        if (status !== 'recording') {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.isComposing || !composerMarkerRef.current || recordingOwner !== composerMarkerRef.current) {
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                confirmWith(dictationAutoSend ? 'send' : 'insert');
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                void cancelDictation();
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [status, confirmWith, cancelDictation, dictationAutoSend]);

    const overlayRef = React.useRef<HTMLDivElement | null>(null);
    const transcriptAreaRef = React.useRef<HTMLDivElement | null>(null);
    const transcriptContentRef = React.useRef<HTMLDivElement | null>(null);
    const [footerHeight, setFooterHeight] = React.useState<number | null>(null);
    const isActiveStatus = status !== 'idle';
    const hasSalvageText = status === 'failed' && Boolean(partialTranscript.trim());

    const onContentHeightChangeRef = React.useRef(onContentHeightChange);
    React.useEffect(() => {
        onContentHeightChangeRef.current = onContentHeightChange;
    }, [onContentHeightChange]);
    const hasReportedHeightRef = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!hasSalvageText) {
            if (hasReportedHeightRef.current) {
                hasReportedHeightRef.current = false;
                onContentHeightChangeRef.current?.(null);
            }
            return;
        }
        const area = transcriptAreaRef.current;
        const content = transcriptContentRef.current;
        if (!area || !content) return;
        const firstReport = !hasReportedHeightRef.current;
        let followEnd = firstReport
            || area.scrollHeight - area.scrollTop - area.clientHeight <= 24;
        const trackScroll = () => {
            followEnd = area.scrollHeight - area.scrollTop - area.clientHeight <= 24;
        };
        area.addEventListener('scroll', trackScroll, { passive: true });
        const reportHeight = () => {
            const style = window.getComputedStyle(area);
            const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
            hasReportedHeightRef.current = true;
            onContentHeightChangeRef.current?.(content.offsetHeight + padding);
            if (followEnd) {
                area.scrollTop = area.scrollHeight;
            }
        };
        reportHeight();
        const initialFollowFrame = firstReport ? window.requestAnimationFrame(() => {
            area.scrollTop = area.scrollHeight;
            followEnd = true;
        }) : null;
        const cleanupScroll = () => {
            area.removeEventListener('scroll', trackScroll);
            if (initialFollowFrame !== null) window.cancelAnimationFrame(initialFollowFrame);
        };
        if (!window.ResizeObserver) return cleanupScroll;
        const observer = new window.ResizeObserver(reportHeight);
        observer.observe(content);
        observer.observe(area);
        return () => {
            observer.disconnect();
            cleanupScroll();
        };
    }, [hasSalvageText, partialTranscript]);
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
        const realFooter = overlayRef.current?.closest<HTMLElement>('[data-chat-input-footer="true"]');
        if (realFooter && realFooter.offsetHeight > 0) {
            setFooterHeight(realFooter.offsetHeight);
        }
    }, [isActiveStatus]);

    if (!supported || !dictationEnabled) {
        return null;
    }

    const isActive = status !== 'idle';

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
            <span ref={composerMarkerRef} data-composer-dictation hidden />
            {renderTrigger ? (
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className={footerIconButtonClass}
                    onClick={startRecording}
                    disabled={disabled || isActive}
                    aria-label={t('chat.dictation.start')}
                >
                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}><TooltipLabelWithShortcut label={t('chat.dictation.start')} shortcut={dictationShortcut} /></TooltipContent>
                </Tooltip>
            ) : null}
            {isActive ? (
                <div
                    ref={overlayRef}
                    className={cn(
                        'oc-dictation-overlay absolute inset-0 z-50 flex flex-col overflow-x-hidden overflow-y-hidden',
                        isMobile && 'oc-surface-elevated border border-edge shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
                        isMobile && 'oc-composer-morph-content-fade',
                    )}
                    style={{ borderRadius: radius }}
                    role="dialog"
                    aria-label={t('chat.dictation.overlayAria')}
                >
                    {isMobile ? (
                        <div aria-hidden="true" data-dictation-glass="true" className="oc-surface-floating pointer-events-none absolute inset-0 -z-10" />
                    ) : null}
                    {topAccessory}
                    <ScrollableOverlay
                        ref={transcriptAreaRef}
                        outerClassName="flex-1 min-h-0"
                        className={cn(
                            'px-3',
                            isMobile ? 'pt-3.5 pb-2.5' : 'pt-5 pb-2',
                        )}
                        disableHorizontal
                    >
                        <div ref={transcriptContentRef}>
                            {status === 'failed' && partialTranscript ? (
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
                    </ScrollableOverlay>
                    <div
                        className={cn('flex flex-shrink-0 items-center gap-x-3', footerPaddingClass)}
                        style={footerHeight ? { height: footerHeight } : undefined}
                    >
                        {status === 'recording' ? (
                            <>
                                <span className="relative ms-1 flex size-1.5 flex-shrink-0" aria-hidden="true">
                                    <span
                                        className={cn('relative inline-flex size-1.5 rounded-full', recordingBlink)}
                                        style={{ backgroundColor: currentTheme.colors.status.error }}
                                    />
                                </span>
                                <DictationWaveform subscribeLevel={subscribeLevel} className="block h-4 min-w-0 flex-1" />
                                <span className="typography-meta flex-shrink-0 tabular-nums" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                                    {formatDuration(duration)}
                                </span>
                            </>
                        ) : status === 'uploading' ? (
                            <Icon name="loader-4" className="ms-1 h-4 w-4 animate-spin" style={{ color: currentTheme.colors.surface.mutedForeground }} />
                        ) : null}
                        <div className={cn('ms-auto flex flex-shrink-0 items-center', isMobile ? 'gap-x-1' : 'gap-x-1.5 md:gap-x-3')}>
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
