import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { DictationStatusControls } from '@/components/dictation/DictationStatusControls';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useMessageSelectionEscape } from '@/hooks/useMessageSelectionLifetime';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useOwnSlotComposerRecording } from '@/lib/dictation/composerRecording';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessageSelectionKeys, useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import { useLoadedSessionMessageRecords, useSessionMessageRecordsForExport } from '@/sync/use-sync';
import { copySelectionMarkdown, pickSelectedUnits, saveSelectionImage } from './selectionExport';

type MessageSelectionBarProps = {
    sessionId: string;
    directory: string | null;
    isMobile: boolean;
    radius: string;
};

type ExportKind = 'image' | 'markdown';

const transcriptColumnOf = (bar: HTMLElement | null): HTMLElement | null => (
    bar?.closest('[data-composer-bound]')?.querySelector<HTMLElement>('.chat-scroll .chat-message-column') ?? null
);

const exportWidthOf = (column: HTMLElement | null): number => {
    if (!column) return 0;
    const sidePadding = Number.parseFloat(window.getComputedStyle(column).paddingInlineEnd) || 0;
    return Math.max(0, Math.round(column.getBoundingClientRect().width - 2 * sidePadding));
};

export const MessageSelectionBar: React.FC<MessageSelectionBarProps> = ({ sessionId, directory, isMobile, radius }) => {
    const { t } = useI18n();
    const keys = useMessageSelectionKeys(sessionId);
    const vscode = useRuntimeAPIs().vscode;
    const theme = useOptionalThemeSystem()?.currentTheme;
    const readLoadedRecords = useLoadedSessionMessageRecords();
    const loadCompleteRecords = useSessionMessageRecordsForExport();
    const [busy, setBusy] = React.useState<ExportKind | null>(null);
    const barRef = React.useRef<HTMLDivElement>(null);
    const recording = useOwnSlotComposerRecording();
    useMessageSelectionEscape(sessionId);

    const end = React.useCallback(() => useMessageSelectionStore.getState().end(sessionId), [sessionId]);

    const resolveUnits = React.useCallback(async (selectionId: number) => {
        if (!directory) return null;
        const loaded = readLoadedRecords({ directory, sessionID: sessionId });
        const fromLoaded = loaded ? pickSelectedUnits(loaded, keys) : null;
        if (fromLoaded?.complete) return fromLoaded.units;
        const records = await loadCompleteRecords({ directory, sessionID: sessionId });
        if (!records) return null;
        const picked = pickSelectedUnits(records, keys);
        if (picked.complete) return picked.units;
        if (useMessageSelectionStore.getState().selection?.id !== selectionId) return null;
        useMessageSelectionStore.getState().retain(selectionId, new Set(picked.units.map((unit) => unit.key)));
        toast.error(t('chat.messageSelection.toast.missing'));
        return null;
    }, [directory, keys, loadCompleteRecords, readLoadedRecords, sessionId, t]);

    const runExport = React.useCallback(async (kind: ExportKind) => {
        const selectionId = useMessageSelectionStore.getState().selection?.id;
        if (busy || keys.size === 0 || selectionId === undefined) return;
        const isCurrent = () => useMessageSelectionStore.getState().selection?.id === selectionId;
        setBusy(kind);
        try {
            const units = await resolveUnits(selectionId);
            if (!units || !isCurrent()) return;
            if (kind === 'markdown') {
                if (!(await copySelectionMarkdown(units))) {
                    toast.error(t('chat.messageSelection.toast.copyFailed'));
                    return;
                }
                toast.success(t('chat.messageSelection.toast.copied'));
            } else {
                const column = transcriptColumnOf(barRef.current);
                const result = await saveSelectionImage({
                    units,
                    width: exportWidthOf(column),
                    syntaxStyle: column?.closest('.chat-scroll')?.querySelector('[data-markdown-content]')?.getAttribute('style') ?? null,
                    theme,
                    vscode,
                });
                if (result === 'canceled') return;
                toast.success(t('chat.messageBody.toast.imageSaved'));
            }
            useMessageSelectionStore.getState().endSelection(selectionId);
        } catch (error) {
            console.error('Failed to share selected messages:', error);
            toast.error(t(kind === 'image' ? 'chat.messageBody.toast.generateImageFailed' : 'chat.messageSelection.toast.copyFailed'));
        } finally {
            setBusy(null);
        }
    }, [busy, keys.size, resolveUnits, t, theme, vscode]);

    const nothingSelected = keys.size === 0;
    const buttonSize = isMobile ? 'lg' : 'default';
    const iconOnly = isMobile && recording !== null;
    return (
        <div
            ref={barRef}
            data-message-selection-bar=""
            className="oc-surface-floating oc-composer-surface oc-glass-floating oc-composer-sheen flex items-center gap-2 p-2"
            style={{ borderRadius: radius }}
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn('shrink-0 text-muted-foreground hover:text-foreground', isMobile && 'size-9')}
                        aria-label={t('chat.messageSelection.cancel')}
                        onClick={end}
                    >
                        <Icon name="close" className="size-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageSelection.cancel')}</TooltipContent>
            </Tooltip>
            <span
                className={cn('min-w-0 flex-1 truncate typography-ui-label tabular-nums', nothingSelected ? 'text-muted-foreground' : 'text-foreground')}
                aria-live="polite"
                aria-label={nothingSelected ? undefined : t('chat.messageSelection.count', { count: keys.size })}
            >
                {nothingSelected
                    ? t('chat.messageSelection.empty')
                    : isMobile ? keys.size : t('chat.messageSelection.count', { count: keys.size })}
            </span>
            {recording ? (
                <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground">
                    <DictationStatusControls
                        view={recording.view}
                        actions={recording.actions}
                        buttonClassName={buttonVariants({ variant: 'ghost', size: 'icon', className: cn('text-muted-foreground hover:text-foreground', isMobile && 'size-9') })}
                    />
                </span>
            ) : null}
            <Button
                type="button"
                variant="outline"
                size={iconOnly ? 'icon' : buttonSize}
                className={cn('shrink-0', iconOnly && 'size-9')}
                aria-label={iconOnly ? t('chat.messageSelection.copyMarkdown') : undefined}
                disabled={nothingSelected || busy !== null}
                onClick={() => void runExport('markdown')}
            >
                {busy === 'markdown' ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="file-copy" className="size-4" />}
                {iconOnly ? null : t(isMobile ? 'chat.messageSelection.copyMarkdownShort' : 'chat.messageSelection.copyMarkdown')}
            </Button>
            <Button
                type="button"
                variant="default"
                size={iconOnly ? 'icon' : buttonSize}
                className={cn('shrink-0', iconOnly && 'size-9')}
                aria-label={iconOnly ? t('chat.messageSelection.saveImage') : undefined}
                disabled={nothingSelected || busy !== null}
                onClick={() => void runExport('image')}
            >
                {busy === 'image' ? <Icon name="loader-4" className="size-4 animate-spin" /> : <Icon name="image-download" className="size-4" />}
                {iconOnly ? null : t(isMobile ? 'chat.messageSelection.saveImageShort' : 'chat.messageSelection.saveImage')}
            </Button>
        </div>
    );
};
