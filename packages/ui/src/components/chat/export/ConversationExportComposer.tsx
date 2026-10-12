import React from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChatMessageEntry } from '../lib/turns/types';
import { buildTurnImageExportSource, saveMessageImageExport } from '../message/imageExport';
import { collectSelectedConversationMessages } from './selectedMessages';
import { formatSelectedConversationMarkdown } from './selectionMarkdown';
import { useConversationSelectionActive, useConversationSelectionStore } from './selectionContext';
import type { ConversationSelectionStore } from './selectionStore';
import { SelectionActionPanel } from '../message/SelectionActionPanel';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';

const ExportToolbar: React.FC<{
    store: ConversationSelectionStore;
    getMessages: () => ChatMessageEntry[];
    columnRef: React.RefObject<HTMLDivElement | null>;
}> = ({ store, getMessages, columnRef }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const { vscode } = useRuntimeAPIs();
    const count = useStore(store, (state) => state.selected.size);
    const [busy, setBusy] = React.useState<'image' | 'markdown' | null>(null);
    const cancelRef = React.useRef<HTMLButtonElement>(null);
    React.useEffect(() => {
        cancelRef.current?.focus({ preventScroll: true });
        const onEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            store.getState().cancel();
        };
        window.addEventListener('keydown', onEscape, true);
        return () => window.removeEventListener('keydown', onEscape, true);
    }, [store]);

    const exportSelection = async (format: 'image' | 'markdown') => {
        if (busy) return;
        const selected = store.getState().selected;
        const messages = collectSelectedConversationMessages(getMessages(), selected);
        if (messages.length !== selected.size) {
            toast.error(t('chat.export.selectionUnavailable'));
            return;
        }
        if (messages.length === 0) {
            toast.error(t('chat.export.empty'));
            return;
        }
        const labels = { user: t('chat.export.user'), assistant: t('chat.export.assistant'), attachment: t('chat.export.attachment') };
        setBusy(format);
        try {
            if (format === 'markdown') {
                const copied = await copyTextToClipboard(formatSelectedConversationMarkdown(messages, labels));
                if (!copied.ok) throw new Error(copied.error);
                toast.success(t('chat.messageBody.toast.copied'));
            } else {
                const root = columnRef.current?.querySelector<HTMLElement>('[data-chat-quote-root]');
                const syntaxStyle = columnRef.current?.querySelector('[data-markdown-content]')?.getAttribute('style') ?? null;
                const source = await buildTurnImageExportSource([formatSelectedConversationMarkdown(messages, labels)], syntaxStyle);
                const exportWidth = Math.min(800, Math.max(360, root?.getBoundingClientRect().width ?? 720));
                const result = await saveMessageImageExport(source, `conversation-${Date.now()}.png`, vscode, exportWidth);
                if (result === 'saved') toast.success(t('chat.messageBody.toast.imageSaved'));
            }
        } catch (error) {
            console.error('Conversation export failed:', error);
            toast.error(t(format === 'image' ? 'chat.messageBody.toast.generateImageFailed' : 'chat.export.copyFailed'));
        } finally {
            setBusy(null);
        }
    };

    return (
        <SelectionActionPanel
            mobile={isMobile}
            opaque
            className={isMobile ? 'inset-s-0 inset-e-0 bg-background px-3 pt-3' : 'mx-auto w-fit max-w-full'}
            style={isMobile ? { bottom: 0, paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' } : undefined}
            data-conversation-export-toolbar="true"
        >
            <div className={cn('items-center gap-2', isMobile ? 'grid grid-cols-2' : 'flex flex-wrap px-2')} role="toolbar" aria-label={t('chat.export.selectMore')}>
                <span className="me-auto px-2 typography-meta text-muted-foreground" role="status">{t('chat.export.selectionCount', { count })}</span>
                <Button ref={cancelRef} variant="ghost" size="sm" className="justify-self-end" onClick={() => store.getState().cancel()}>{t('dialog.common.actions.cancel')}</Button>
                <Button variant="ghost" size={isMobile ? 'lg' : 'sm'} className={cn('min-w-0', isMobile ? 'rounded-xl bg-foreground/[0.04]' : 'rounded-full')} disabled={count === 0 || busy !== null} onClick={() => void exportSelection('image')}>
                    <Icon name={busy === 'image' ? 'loader-4' : 'image-download'} className={busy === 'image' ? 'size-4 animate-spin' : 'size-4'} />
                    <span className="min-w-0 whitespace-normal leading-tight">{t(busy === 'image' ? 'chat.messageBody.actions.savingImage' : 'chat.messageBody.actions.saveAsImage')}</span>
                </Button>
                <Button size={isMobile ? 'lg' : 'sm'} className={cn('min-w-0', isMobile ? 'rounded-xl' : 'rounded-full')} disabled={count === 0 || busy !== null} onClick={() => void exportSelection('markdown')}>
                    <Icon name={busy === 'markdown' ? 'loader-4' : 'file-copy'} className={busy === 'markdown' ? 'size-4 animate-spin' : 'size-4'} />
                    <span className="min-w-0 whitespace-normal leading-tight">{t('chat.export.copyMarkdown')}</span>
                </Button>
            </div>
        </SelectionActionPanel>
    );
};

/** Keeps the editor mounted so canceling selection restores its draft and attachments. */
export const ConversationExportComposer: React.FC<{
    children: React.ReactNode;
    getMessages: () => ChatMessageEntry[];
    columnRef: React.RefObject<HTMLDivElement | null>;
}> = ({ children, getMessages, columnRef }) => {
    const active = useConversationSelectionActive();
    const store = useConversationSelectionStore();
    return (
        <>
            <div
                className="contents"
                style={active ? { visibility: 'hidden' } : undefined}
                inert={active || undefined}
                data-conversation-export-composer="true"
            >
                {children}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-3 [&>*]:pointer-events-auto">
                {active && store ? <ExportToolbar store={store} getMessages={getMessages} columnRef={columnRef} /> : null}
            </div>
        </>
    );
};
