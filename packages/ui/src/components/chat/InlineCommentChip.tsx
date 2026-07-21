import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

interface InlineCommentChipProps {
    draft: InlineCommentDraft;
    sessionKey: string;
}

export const InlineCommentChip: React.FC<InlineCommentChipProps> = React.memo(({ draft, sessionKey }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);
    const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);

    const autoEditDraftId = useInlineCommentDraftStore((state) => state.autoEditDraftId);
    const setAutoEditDraftId = useInlineCommentDraftStore((state) => state.setAutoEditDraftId);

    const [open, setOpen] = React.useState(false);
    const [editValue, setEditValue] = React.useState(draft.text);
    const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

    // Auto-open the editor for a freshly-added draft (VS Code "Add Comment" flow).
    React.useEffect(() => {
        if (autoEditDraftId === draft.id) {
            setEditValue(draft.text);
            setOpen(true);
            setAutoEditDraftId(null);
        }
    }, [autoEditDraftId, draft.id, draft.text, setAutoEditDraftId]);

    const label = draft.startLine === draft.endLine
        ? `${draft.fileLabel}:${draft.startLine}`
        : `${draft.fileLabel}:${draft.startLine}-${draft.endLine}`;
    const preview = draft.text.length > 40 ? `${draft.text.slice(0, 40)}…` : draft.text;

    const syncPortalContainer = () => {
        const container = triggerRef.current?.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null;
        setPortalContainer(container || null);
    };

    const handleOpenChange = (next: boolean) => {
        if (next) {
            setEditValue(draft.text);
        } else if (!draft.text.trim()) {
            // Dismissing the editor of a never-saved (empty) draft discards it.
            removeDraft(sessionKey, draft.id);
        }
        setOpen(next);
    };

    React.useEffect(() => {
        if (open) {
            const id = requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (el) {
                    el.focus();
                    el.setSelectionRange(el.value.length, el.value.length);
                }
            });
            return () => cancelAnimationFrame(id);
        }
        return undefined;
    }, [open]);

    const handleSave = () => {
        const trimmed = editValue.trim();
        if (!trimmed) {
            removeDraft(sessionKey, draft.id);
            setOpen(false);
            return;
        }
        updateDraft(sessionKey, draft.id, { text: trimmed });
        setOpen(false);
    };

    const handleCancel = () => {
        // Cancelling a never-saved (empty) draft discards it entirely, so the
        // "Add Comment" flow doesn't leave a blank chip behind.
        if (!draft.text.trim()) {
            removeDraft(sessionKey, draft.id);
            setOpen(false);
            return;
        }
        setEditValue(draft.text);
        setOpen(false);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            handleSave();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    };

    return (
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
            <div
                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                style={{
                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                    borderColor: currentTheme?.colors?.interactive?.border,
                }}
            >
                <Popover.Trigger
                    render={
                        <button
                            ref={triggerRef}
                            type="button"
                            className="inline-flex max-w-[280px] items-center gap-1.5 rounded-md text-left hover:opacity-80"
                            onPointerDownCapture={syncPortalContainer}
                            onFocusCapture={syncPortalContainer}
                            aria-label={t('chat.chatInput.reviewCommentEdit')}
                            title={t('chat.chatInput.reviewCommentEdit')}
                        >
                            <Icon
                                name="chat-1"
                                className="h-3 w-3 shrink-0"
                                style={{ color: currentTheme?.colors?.status?.warning }}
                            />
                            <span
                                className="max-w-[120px] shrink-0 truncate text-xs font-medium text-foreground"
                                title={label}
                            >
                                {label}
                            </span>
                            {preview ? (
                                <span
                                    className="max-w-[160px] truncate text-xs text-muted-foreground"
                                    title={draft.text}
                                >
                                    {preview}
                                </span>
                            ) : null}
                        </button>
                    }
                />
                <button
                    type="button"
                    className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
                    onClick={() => removeDraft(sessionKey, draft.id)}
                    aria-label={t('chat.chatInput.reviewCommentsRemove')}
                    title={t('chat.chatInput.reviewCommentsRemove')}
                >
                    <Icon name="close" className="h-3 w-3" />
                </button>
            </div>
            <Popover.Portal container={portalContainer || undefined}>
                <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={8}>
                    <Popover.Popup
                        className="w-[320px] max-w-[calc(100cqw-4ch)] rounded-xl border p-3 shadow-lg origin-[var(--transform-origin)] transition-all duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95"
                        style={{
                            backgroundColor: currentTheme?.colors?.surface?.elevated,
                            borderColor: currentTheme?.colors?.interactive?.border,
                            color: currentTheme?.colors?.surface?.foreground,
                        }}
                    >
                        <div className="mb-2 flex items-center gap-1.5">
                            <Icon
                                name="chat-1"
                                className="h-3.5 w-3.5 shrink-0"
                                style={{ color: currentTheme?.colors?.status?.warning }}
                            />
                            <span
                                className="truncate text-xs font-semibold"
                                style={{ color: currentTheme?.colors?.surface?.foreground }}
                                title={label}
                            >
                                {label}
                            </span>
                        </div>
                        {draft.code ? (
                            <pre
                                className="mb-2 max-h-24 overflow-auto rounded-md px-2 py-1.5 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.muted,
                                    color: currentTheme?.colors?.surface?.mutedForeground,
                                }}
                            >
                                {draft.code}
                            </pre>
                        ) : null}
                        <textarea
                            ref={textareaRef}
                            value={editValue}
                            onChange={(event) => setEditValue(event.target.value)}
                            onKeyDown={handleKeyDown}
                            rows={3}
                            placeholder={t('chat.chatInput.reviewCommentEditPlaceholder')}
                            className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1"
                            style={{
                                borderColor: currentTheme?.colors?.interactive?.border,
                                color: currentTheme?.colors?.surface?.foreground,
                            }}
                        />
                        <div className="mt-2 flex justify-end gap-2">
                            <Button size="xs" variant="ghost" onClick={handleCancel}>
                                {t('chat.chatInput.reviewCommentCancel')}
                            </Button>
                            <Button size="xs" variant="default" onClick={handleSave}>
                                {t('chat.chatInput.reviewCommentSave')}
                            </Button>
                        </div>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
});

InlineCommentChip.displayName = 'InlineCommentChip';

export default InlineCommentChip;
