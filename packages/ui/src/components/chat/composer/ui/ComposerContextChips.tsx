/**
 * Context chips above the composer.
 *
 * Each chip stands for context that will be attached to the next message but
 * is not part of its text: review comments left in a diff, preview
 * annotations, terminal selections, PR context, chat quotes. Hovering (or
 * tapping) a chip opens a stacked preview of its items above the composer,
 * where a comment the user wrote can be edited in place and any item removed
 * before sending.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
    EMPTY_INLINE_COMMENT_DRAFTS,
    getInlineCommentDraftKey,
    useInlineCommentDraftStore,
    type InlineCommentDraft,
    type InlineCommentDraftTarget,
    type InlineCommentSource,
} from '@/stores/useInlineCommentDraftStore';
import type { Theme } from '@/types/theme';

export interface ComposerContextChipsProps {
    draftTarget: InlineCommentDraftTarget | null;
    colors: Theme['colors'];
}

/** Chip groups: every terminal selection is its own chip; the rest group by kind. */
type ChipGroup = {
    key: string;
    icon: IconName;
    iconClassName?: string;
    label: string;
    count: number;
    drafts: InlineCommentDraft[];
};

const REVIEW_SOURCES: readonly InlineCommentSource[] = ['diff', 'file', 'plan', 'file-quote'];

/** Sources whose drafts carry a user-written comment that can be edited. */
const editableSource = (source: InlineCommentSource): boolean => source !== 'terminal';

/** Captured code/output kinds read better monospaced; quoted prose does not. */
const monoSource = (source: InlineCommentSource): boolean =>
    source !== 'chat-quote' && source !== 'preview-annotation' && source !== 'file-quote';

const basename = (path: string): string => {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
};

const ENTRY_ACTION_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]';
const ENTRY_LABEL_CLASS = 'text-[10px] font-medium uppercase tracking-wide text-[var(--surface-mutedForeground)] opacity-60';

const DraftPreviewEntry: React.FC<{
    draft: InlineCommentDraft;
    index: number;
    title: string;
    editing: boolean;
    onStartEdit: () => void;
    onEndEdit: () => void;
    onRemove: () => void;
    onSaveComment: ((text: string) => void) | null;
}> = ({ draft, index, title, editing, onStartEdit, onEndEdit, onRemove, onSaveComment }) => {
    const { t } = useI18n();
    const [editText, setEditText] = React.useState(draft.text);
    const editRef = React.useRef<HTMLTextAreaElement>(null);

    React.useEffect(() => {
        if (!editing) return;
        setEditText(draft.text);
        queueMicrotask(() => {
            const element = editRef.current;
            if (element) {
                element.focus();
                element.setSelectionRange(element.value.length, element.value.length);
            }
        });
        // The draft text at edit start is the baseline; later store updates are
        // our own saves.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing]);

    const commitEdit = () => {
        if (onSaveComment && editText !== draft.text) {
            onSaveComment(editText);
        }
        onEndEdit();
    };

    const cancelEdit = () => {
        setEditText(draft.text);
        onEndEdit();
    };

    // Keep focus in the textarea while a header button is pressed: without
    // this the textarea's blur commits first, the header re-renders under the
    // pointer, and the click lands on the button that replaced the pressed one
    // (save punches through to edit, cancel to remove).
    const keepEditorFocus = (event: React.PointerEvent) => {
        if (editing) event.preventDefault();
    };

    return (
        <div>
            <div className="flex items-center gap-1.5 px-3 py-1.5"
                style={{ backgroundColor: 'color-mix(in srgb, var(--surface-mutedForeground) 8%, transparent)' }}>
                <span className="text-xs font-medium text-[var(--surface-mutedForeground)]">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--surface-foreground)]" title={title}>
                    {title}
                </span>
                {onSaveComment ? (
                    <button
                        type="button"
                        className={ENTRY_ACTION_CLASS}
                        style={{ minHeight: 0, minWidth: 0 }}
                        onPointerDown={keepEditorFocus}
                        onClick={editing ? commitEdit : onStartEdit}
                        aria-label={t('chat.chatInput.contextPreview.edit')}
                        title={t('chat.chatInput.contextPreview.edit')}
                    >
                        <Icon name={editing ? 'check' : 'pencil'} className="h-3 w-3" />
                    </button>
                ) : null}
                <button
                    type="button"
                    className={ENTRY_ACTION_CLASS}
                    style={{ minHeight: 0, minWidth: 0 }}
                    onPointerDown={keepEditorFocus}
                    onClick={editing ? cancelEdit : onRemove}
                    aria-label={t('chat.chatInput.contextPreview.remove')}
                    title={t('chat.chatInput.contextPreview.remove')}
                >
                    <Icon name="close" className="h-3 w-3" />
                </button>
            </div>
            <div className="space-y-2 px-3 py-2">
                {draft.code.trim() ? (
                    <div>
                        <div className={ENTRY_LABEL_CLASS}>{t('chat.chatInput.contextPreview.selectedLabel')}</div>
                        <div
                            className={
                                monoSource(draft.source)
                                    ? 'mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-[var(--surface-foreground)]'
                                    : 'mt-0.5 whitespace-pre-wrap break-words text-sm text-[var(--surface-foreground)]'
                            }
                        >
                            {draft.code}
                        </div>
                    </div>
                ) : null}
                {onSaveComment && (editing || draft.text.trim()) ? (
                    <div>
                        <div className={ENTRY_LABEL_CLASS}>{t('chat.chatInput.contextPreview.commentLabel')}</div>
                        {editing ? (
                            <textarea
                                ref={editRef}
                                rows={2}
                                value={editText}
                                onChange={(event) => setEditText(event.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault();
                                        commitEdit();
                                    } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setEditText(draft.text);
                                        onEndEdit();
                                    }
                                }}
                                placeholder={t('chat.textSelection.comment.placeholder')}
                                className="mt-0.5 w-full resize-none rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-2 py-1 text-sm text-[var(--surface-foreground)] outline-none placeholder:text-[var(--surface-mutedForeground)]"
                                style={{ minHeight: 0 }}
                            />
                        ) : (
                            <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-[var(--surface-foreground)]">{draft.text}</div>
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export function ComposerContextChips({ draftTarget, colors }: ComposerContextChipsProps) {
    const { t } = useI18n();
    const draftKey = draftTarget
        ? getInlineCommentDraftKey(getRuntimeKey(), draftTarget.directory, draftTarget.sessionKey)
        : null;
    const drafts = useInlineCommentDraftStore(
        React.useCallback(
            (state) => (draftKey ? state.drafts[draftKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS),
            [draftKey],
        ),
    );
    const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);
    const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);

    const [openGroupKey, setOpenGroupKey] = React.useState<string | null>(null);
    const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null);
    const editingRef = React.useRef<string | null>(null);
    editingRef.current = editingDraftId;
    const containerRef = React.useRef<HTMLDivElement>(null);
    const closeTimerRef = React.useRef<number | null>(null);

    const cancelClose = React.useCallback(() => {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);
    // Hover-away close. Suspended while a comment is being edited: entering or
    // leaving edit mode reflows the panel under the pointer, and a synthetic
    // mouseleave from that reflow must not tear the editor down.
    const scheduleClose = React.useCallback(() => {
        if (editingRef.current) return;
        cancelClose();
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            setOpenGroupKey(null);
        }, 150);
    }, [cancelClose]);
    React.useEffect(() => cancelClose, [cancelClose]);

    // Clicking outside the chips + panel closes the preview even when a reflow
    // swallowed the mouseleave (e.g. right after finishing an edit).
    React.useEffect(() => {
        if (!openGroupKey) return;
        const handlePointerDown = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is always a
            // Node; `contains` only needs that.
            if (containerRef.current?.contains(event.target as Node)) return;
            setOpenGroupKey(null);
            setEditingDraftId(null);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [openGroupKey]);

    const titleFor = React.useCallback((draft: InlineCommentDraft): string => {
        switch (draft.source) {
            case 'terminal':
                return t('chat.chatInput.terminalContext', {
                    terminal: draft.fileLabel,
                    start: draft.startLine,
                    end: draft.endLine,
                });
            case 'preview-annotation':
                return t('chat.message.context.browserAnnotation', { page: draft.fileLabel });
            case 'pr-comment':
                return t('chat.message.context.prComment', { label: draft.fileLabel });
            case 'pr-check':
                return t('chat.message.context.prCheck', { label: draft.fileLabel });
            case 'chat-quote':
                return t('chat.message.context.chatQuote');
            case 'file-quote':
                return draft.startLine > 0 && draft.endLine > 0
                    ? (draft.startLine === draft.endLine
                        ? t('chat.message.context.codeCommentLine', { file: basename(draft.fileLabel), line: draft.startLine })
                        : t('chat.message.context.codeComment', { file: basename(draft.fileLabel), start: draft.startLine, end: draft.endLine }))
                    : t('chat.message.context.fileQuote', { file: basename(draft.fileLabel) });
            default:
                return draft.startLine === draft.endLine
                    ? t('chat.message.context.codeCommentLine', { file: basename(draft.fileLabel), line: draft.startLine })
                    : t('chat.message.context.codeComment', { file: basename(draft.fileLabel), start: draft.startLine, end: draft.endLine });
        }
    }, [t]);

    const groups = React.useMemo<ChipGroup[]>(() => {
        const result: ChipGroup[] = [];
        const byKind = (
            key: string,
            icon: IconName,
            label: string,
            match: (draft: InlineCommentDraft) => boolean,
            iconClassName?: string,
        ) => {
            const matched = drafts.filter(match);
            if (matched.length > 0) {
                result.push({ key, icon, iconClassName, label, count: matched.length, drafts: matched });
            }
        };
        for (const draft of drafts) {
            if (draft.source !== 'terminal') continue;
            result.push({
                key: `terminal-${draft.id}`,
                icon: 'terminal',
                label: t('chat.chatInput.terminalContext', {
                    terminal: draft.fileLabel,
                    start: draft.startLine,
                    end: draft.endLine,
                }),
                count: 0,
                drafts: [draft],
            });
        }
        byKind('review', 'chat-1', t('chat.chatInput.reviewComments'), (draft) => REVIEW_SOURCES.includes(draft.source));
        byKind('pr-comment', 'git-pull-request', t('chat.chatInput.prCommentContext'), (draft) => draft.source === 'pr-comment');
        byKind('pr-check', 'close-circle', t('chat.chatInput.prCheckContext'), (draft) => draft.source === 'pr-check', 'text-[var(--status-error)]');
        byKind('chat-quote', 'chat-1', t('chat.chatInput.chatQuoteContext'), (draft) => draft.source === 'chat-quote');
        byKind('annotation', 'global', t('chat.chatInput.previewAnnotations'), (draft) => draft.source === 'preview-annotation');
        return result;
    }, [drafts, t]);

    React.useEffect(() => {
        if (openGroupKey && !groups.some((group) => group.key === openGroupKey)) {
            setOpenGroupKey(null);
            setEditingDraftId(null);
        }
    }, [groups, openGroupKey]);

    if (!draftTarget || drafts.length === 0) return null;

    const openGroup = openGroupKey ? groups.find((group) => group.key === openGroupKey) ?? null : null;

    return (
        <div className="relative" ref={containerRef}>
            {openGroup ? (
                <div
                    className="oc-glass-popover absolute bottom-full left-0 z-30 mb-1.5 w-full max-w-[480px] overflow-hidden rounded-xl border border-[var(--interactive-border)] shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]"
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                >
                    <div className="max-h-[min(50vh,420px)] divide-y divide-[var(--interactive-border)] overflow-y-auto">
                        {openGroup.drafts.map((draft, index) => (
                            <DraftPreviewEntry
                                key={draft.id}
                                draft={draft}
                                index={index}
                                title={titleFor(draft)}
                                editing={editingDraftId === draft.id}
                                onStartEdit={() => setEditingDraftId(draft.id)}
                                onEndEdit={() => setEditingDraftId((current) => (current === draft.id ? null : current))}
                                onRemove={() => removeDraft(draftTarget, draft.id)}
                                onSaveComment={editableSource(draft.source)
                                    ? (text) => updateDraft(draftTarget, draft.id, { text })
                                    : null}
                            />
                        ))}
                    </div>
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pb-2">
                {groups.map((group) => (
                    <button
                        key={group.key}
                        type="button"
                        className="inline-flex max-w-full items-center gap-1.5 rounded-xl border px-2.5 py-1 text-left"
                        style={{
                            backgroundColor: colors?.surface?.elevated,
                            borderColor: colors?.interactive?.border,
                        }}
                        onMouseEnter={() => {
                            cancelClose();
                            setOpenGroupKey(group.key);
                        }}
                        onMouseLeave={scheduleClose}
                        onClick={() => {
                            if (editingRef.current) return;
                            setOpenGroupKey((current) => (current === group.key ? null : group.key));
                        }}
                        aria-expanded={openGroupKey === group.key}
                    >
                        <Icon name={group.icon} className={`h-3.5 w-3.5 shrink-0 text-muted-foreground ${group.iconClassName ?? ''}`} />
                        <span className="truncate text-xs font-medium text-muted-foreground">{group.label}</span>
                        {group.count > 0 ? (
                            <span className="text-xs font-semibold" style={{ color: colors?.status?.info }}>
                                {group.count}
                            </span>
                        ) : null}
                    </button>
                ))}
            </div>
        </div>
    );
}
