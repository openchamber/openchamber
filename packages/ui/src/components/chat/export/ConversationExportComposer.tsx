import React from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
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
import { TextSelectionToolbar, TextSelectionToolbarAction } from '../message/TextSelectionToolbar';
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
        <TextSelectionToolbar
            mobile={isMobile}
            className={cn('max-w-full', !isMobile && '@max-[30rem]/conversation-export:block @max-[30rem]/conversation-export:w-full @max-[30rem]/conversation-export:rounded-2xl')}
            data-conversation-export-toolbar="true"
            role="toolbar"
            aria-label={t('chat.export.selectMore')}
        >
            <div className={isMobile ? 'flex items-center justify-between' : 'contents @max-[30rem]/conversation-export:mb-2 @max-[30rem]/conversation-export:flex @max-[30rem]/conversation-export:items-center @max-[30rem]/conversation-export:justify-between'}>
                <span className="min-w-0 truncate px-3 typography-meta text-muted-foreground" role="status">{t('chat.export.selectionCount', { count })}</span>
                <Button ref={cancelRef} variant="ghost" className="justify-start rounded-full text-start text-foreground" onClick={() => store.getState().cancel()}>{t('dialog.common.actions.cancel')}</Button>
            </div>
            <div className={isMobile ? 'grid grid-cols-2 gap-2' : 'contents @max-[30rem]/conversation-export:grid @max-[30rem]/conversation-export:grid-cols-2 @max-[30rem]/conversation-export:gap-2'}>
                {!isMobile ? <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)] @max-[30rem]/conversation-export:hidden" /> : null}
                <TextSelectionToolbarAction mobile={isMobile} aria-busy={busy === 'image'} disabled={count === 0 || busy !== null} onClick={() => void exportSelection('image')}>
                    <span className="min-w-0 whitespace-normal leading-tight">{t(busy === 'image' ? 'chat.messageBody.actions.savingImage' : 'chat.messageBody.actions.saveAsImage')}</span>
                </TextSelectionToolbarAction>
                {!isMobile ? <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)] @max-[30rem]/conversation-export:hidden" /> : null}
                <TextSelectionToolbarAction mobile={isMobile} aria-busy={busy === 'markdown'} disabled={count === 0 || busy !== null} onClick={() => void exportSelection('markdown')}>
                    <span className="min-w-0 whitespace-normal leading-tight">{t('chat.export.copyMarkdown')}</span>
                </TextSelectionToolbarAction>
            </div>
        </TextSelectionToolbar>
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
            <div className="@container/conversation-export pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-3 [&>*]:pointer-events-auto">
                {active && store ? <ExportToolbar store={store} getMessages={getMessages} columnRef={columnRef} /> : null}
            </div>
        </>
    );
};
