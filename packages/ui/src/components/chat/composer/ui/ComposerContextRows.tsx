
import React from 'react';
import { flushSync } from 'react-dom';

import { CommentTextEditor } from '@/components/comments/CommentTextEditor';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { readBrowserAnnotationPrompt, withoutBrowserAnnotationComment, withoutBrowserAnnotationScreenshot } from '@/lib/browser/annotationPrompt';
import { legacyChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { quoteDisplayText } from '@/lib/messages/quoteDisplayText';
import { fileWithDiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { INLINE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS } from '@/lib/messages/inlineMessageLinks';
import { isWholeFileComment } from '@/components/comments/wholeFileComment';
import {
    EMPTY_INLINE_COMMENT_DRAFTS,
    getInlineCommentDraftKey,
    useInlineCommentDraftStore,
    type InlineCommentDraft,
    type InlineCommentDraftTarget,
} from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';
import { useChatQuoteHighlightApi, type ChatQuoteMark } from '../../hooks/chatQuoteHighlightStore';
import { withAttachmentChips } from '../../message/parts/attachmentCitationChips';
import { useMobileCommentComposerController } from '../comment/MobileCommentComposerContext';
import { foldContextRows } from './contextRowFold';
import { useRevealOnOpen } from './useRevealOnOpen';

interface ComposerContextRowsProps {
    draftTarget: InlineCommentDraftTarget | null;
    isMobile: boolean;
    onOpenAttachment: (filename: string) => void;
    surfaceActive: boolean;
}

const VISIBLE_ROWS = 4;

const QUOTE_BAR_CLASS = 'border-s-3 border-primary/45 ps-2.5';

const LEADING_TEXT_STYLE: React.CSSProperties = { flexShrink: 0, maxWidth: '60%', whiteSpace: 'pre' };
const TEXT_RUN_STYLE: React.CSSProperties = { whiteSpace: 'pre' };

const ROW_ACTION_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground';

type RowView = {
    icon: IconName;
    iconClassName?: string;
    title: string;
    snippet: string;
    quote: string;
    mono: boolean;
    comment: string;
    editable: boolean;
};

const basename = (path: string): string => {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

const location = (file: string, start: number, end: number): string => {
    if (start <= 0) return file;
    return start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
};

const DraftRow: React.FC<{
    draft: InlineCommentDraft;
    view: RowView;
    open: boolean;
    editsInPlace: boolean;
    phoneLayout: boolean;
    onToggle: () => void;
    onClose: () => void;
    onRemove: () => void;
    onSaveComment: (text: string) => boolean;
    composing: boolean;
    onComposeText: (text: string) => boolean;
    onComposeFinish: () => void;
    onComposeCancel: () => void;
    onFocusQuote: ((focused: boolean) => void) | null;
    onRevealQuote: (() => void) | null;
    attachmentFilenames: readonly string[];
    onOpenScreenshot: (() => void) | null;
    onRemoveScreenshot: () => void;
}> = ({ draft, view, open, editsInPlace, phoneLayout, onToggle, onClose, onRemove, onSaveComment, composing, onComposeText, onComposeFinish, onComposeCancel, onFocusQuote, onRevealQuote, attachmentFilenames, onOpenScreenshot, onRemoveScreenshot }) => {
    const { t } = useI18n();
    const [typedText, setTypedText] = React.useState<string | null>(null);
    const editText = typedText ?? view.comment;
    const imagePaste = useCommentImagePaste();
    const editing = open && (editsInPlace || composing) && view.editable;
    const writeThrough = editing && composing;

    const settledRef = React.useRef(false);
    React.useEffect(() => {
        if (!editing) return;
        settledRef.current = false;
        setTypedText(null);
    }, [editing]);

    const commitEdit = () => {
        if (settledRef.current) return;
        if (editText !== view.comment && !onSaveComment(editText)) {
            toast.error(t('inlineComment.toast.noRoom'));
            return;
        }
        settledRef.current = true;
        void imagePaste.attachCitedImages(editText);
        onClose();
    };
    const cancelEdit = () => {
        settledRef.current = true;
        imagePaste.discardPastedImages();
        onClose();
    };
    const composeRejectedRef = React.useRef(false);
    const composeText = (text: string) => {
        if (onComposeText(text)) {
            setTypedText(null);
            composeRejectedRef.current = false;
            return;
        }
        setTypedText(text);
        if (!composeRejectedRef.current) toast.error(t('inlineComment.toast.noRoom'));
        composeRejectedRef.current = true;
    };
    const finishComposing = () => {
        if (settledRef.current) return;
        if (editText !== view.comment && !onComposeText(editText)) {
            toast.error(t('inlineComment.toast.noRoom'));
            return;
        }
        settledRef.current = true;
        void imagePaste.attachCitedImages(editText);
        onComposeFinish();
    };
    const cancelComposing = () => {
        settledRef.current = true;
        imagePaste.discardPastedImages();
        onComposeCancel();
    };
    const finish = writeThrough ? finishComposing : commitEdit;
    const cancel = writeThrough ? cancelComposing : cancelEdit;
    const openRowRef = React.useRef<HTMLDivElement>(null);
    const fieldRef = React.useRef<HTMLDivElement>(null);
    useRevealOnOpen(fieldRef, writeThrough);
    const handleRowBlur = () => {
        const row = openRowRef.current;
        window.setTimeout(() => {
            if (row?.isConnected && row.contains(document.activeElement)) return;
            finish();
        }, 0);
    };
    const keepEditorFocus = (event: React.PointerEvent) => {
        if (editing) event.preventDefault();
    };

    const actions = (
        <span
            className={cn(
                'flex shrink-0 items-center gap-0.5 transition-opacity',
                !open && !phoneLayout && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100',
            )}
        >
            {onRevealQuote && !open ? (
                <HoverTooltip label={t('chat.message.context.showQuoteSource')}>
                    <button
                        type="button"
                        className={ROW_ACTION_CLASS}
                        style={{ minHeight: 0, minWidth: 0 }}
                        onPointerDown={keepEditorFocus}
                        onClick={(event) => {
                            event.stopPropagation();
                            onRevealQuote();
                        }}
                        aria-label={t('chat.message.context.showQuoteSource')}
                    >
                        <Icon name="arrow-up" className="h-3.5 w-3.5" />
                    </button>
                </HoverTooltip>
            ) : null}
            <HoverTooltip label={t('chat.chatInput.contextPreview.remove')}>
                <button
                    type="button"
                    className={ROW_ACTION_CLASS}
                    style={{ minHeight: 0, minWidth: 0 }}
                    onPointerDown={keepEditorFocus}
                    onClick={(event) => {
                        event.stopPropagation();
                        if (editing) {
                            settledRef.current = true;
                            imagePaste.discardPastedImages();
                        }
                        onRemove();
                    }}
                    aria-label={t('chat.chatInput.contextPreview.remove')}
                >
                    <Icon name="close" className="h-3.5 w-3.5" />
                </button>
            </HoverTooltip>
        </span>
    );

    const handleRowKeyDown = (event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggle();
    };

    const focusHandlers = onFocusQuote
        ? { onMouseEnter: () => onFocusQuote(true), onMouseLeave: () => onFocusQuote(false) }
        : {};

    if (!open) {
        const hasComment = view.comment.trim().length > 0;
        return (
            <div
                className="group/row flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 text-sm hover:bg-interactive-hover pointer-coarse:h-9"
                role="button"
                tabIndex={0}
                aria-expanded={false}
                title={view.title}
                onClick={onToggle}
                onKeyDown={handleRowKeyDown}
                {...focusHandlers}
            >
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-full bg-primary/45" />
                <Icon name={view.icon} className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', view.iconClassName)} />
                {phoneLayout && hasComment ? null : (
                    <span
                        dir="auto"
                        className={cn(
                            'min-w-0 truncate text-muted-foreground',
                            view.editable ? 'max-w-[45%] shrink-0' : 'flex-1',
                        )}
                    >
                        {view.snippet}
                    </span>
                )}
                {view.editable ? (
                    hasComment ? (
                        <span dir="auto" className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-pre text-foreground">
                            {withAttachmentChips(firstLine(view.comment), attachmentFilenames, `row-${draft.id}`).map((node, index, nodes) => (
                                React.isValidElement(node)
                                    ? <span key={node.key ?? `chip-${index}`} className="flex min-w-[2.5rem] shrink">{node}</span>
                                    : <span key={`text-${index}`} className="min-w-0 truncate" style={index < nodes.length - 1 ? LEADING_TEXT_STYLE : TEXT_RUN_STYLE}>{node}</span>
                            ))}
                        </span>
                    ) : (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('chat.textSelection.comment.placeholder')}</span>
                    )
                ) : null}
                {onOpenScreenshot && draft.screenshot ? (
                    <Icon name="image" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={draft.screenshot} />
                ) : null}
                {actions}
            </div>
        );
    }

    return (
        <div
            ref={openRowRef}
            className="oc-tile rounded-lg px-1.5 py-1.5"
            onBlur={editing ? handleRowBlur : undefined}
            {...focusHandlers}
        >
            <div
                className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                role="button"
                tabIndex={0}
                aria-expanded
                onPointerDown={keepEditorFocus}
                onClick={editing ? finish : onToggle}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (editing) finish();
                    else onToggle();
                }}
            >
                <Icon name={view.icon} className={cn('ms-1.5 h-3.5 w-3.5 shrink-0', view.iconClassName)} />
                <span dir="auto" className="min-w-0 flex-1 truncate" title={view.title}>{view.title}</span>
                {actions}
            </div>
            {view.quote.trim() ? (
                <div
                    dir="auto"
                    className={cn(
                        'mx-1.5 mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground',
                        QUOTE_BAR_CLASS,
                        view.mono ? 'font-mono text-xs leading-5' : 'text-sm',
                        onRevealQuote && 'cursor-pointer hover:text-foreground',
                    )}
                    onPointerDown={keepEditorFocus}
                    onClick={onRevealQuote ?? undefined}
                    title={onRevealQuote ? t('chat.message.context.showQuoteSource') : undefined}
                >
                    {view.quote}
                </div>
            ) : null}
            {onOpenScreenshot && draft.screenshot ? (
                <div className="group/shot mx-1.5 mt-1.5 flex min-w-0 items-center gap-0.5">
                    <button
                        type="button"
                        className={cn(INLINE_REFERENCE_CHIP_CLASS, 'cursor-pointer transition-colors hover:border-foreground/40')}
                        style={{ minHeight: 0, minWidth: 0 }}
                        onPointerDown={keepEditorFocus}
                        onClick={onOpenScreenshot}
                        title={draft.screenshot}
                    >
                        <FileTypeIcon filePath={draft.screenshot} className="h-[1.1em] w-[1.1em] shrink-0" />
                        <span className={REFERENCE_CHIP_LABEL_CLASS}>{draft.screenshot}</span>
                    </button>
                    <HoverTooltip label={t('chat.chatInput.contextPreview.removeScreenshot')}>
                        <button
                            type="button"
                            className={cn(ROW_ACTION_CLASS, 'opacity-0 transition-opacity group-hover/shot:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100')}
                            style={{ minHeight: 0, minWidth: 0 }}
                            onPointerDown={keepEditorFocus}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRemoveScreenshot();
                            }}
                            aria-label={t('chat.chatInput.contextPreview.removeScreenshot')}
                        >
                            <Icon name="close" className="h-3.5 w-3.5" />
                        </button>
                    </HoverTooltip>
                </div>
            ) : null}
            {editing ? (
                <div ref={fieldRef} className="mx-1.5 mt-1.5">
                    <CommentTextEditor
                        value={editText}
                        onChange={writeThrough ? composeText : setTypedText}
                        onSubmit={finish}
                        onCancel={cancel}
                        enterSubmits
                        imagePaste={imagePaste}
                        placeholder={t('chat.textSelection.comment.placeholder')}
                        aria-label={view.title}
                        className="text-sm leading-5 text-foreground"
                    />
                </div>
            ) : view.comment.trim() ? (
                <div dir="auto" className="mx-1.5 mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
                    {withAttachmentChips(view.comment, attachmentFilenames, `row-${draft.id}`)}
                </div>
            ) : null}
        </div>
    );
};

function ComposerContextRowsView({ draftTarget, isMobile, onOpenAttachment, surfaceActive }: ComposerContextRowsProps) {
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
    const quoteHighlights = useChatQuoteHighlightApi();
    const quotePublisher = React.useId();
    const attachedFiles = useInputStore((state) => state.attachedFiles);
    const removeAttachedFile = useInputStore((state) => state.removeAttachedFile);
    const attachmentFilenames = React.useMemo(() => attachedFiles.map((file) => file.filename), [attachedFiles]);
    const mobileComment = useMobileCommentComposerController();
    const [openId, setOpenId] = React.useState<string | null>(null);
    const [showAll, setShowAll] = React.useState(false);
    const openRowEditsRef = React.useRef(false);
    const listRef = React.useRef<HTMLDivElement>(null);

    const descriptorOf = useSourceControlDescriptorOf();
    const termOf = React.useCallback(
        (draft: InlineCommentDraft): ChangeRequestTerm => (draft.provider ? descriptorOf(draft.provider).terminology.changeRequest : 'pullRequest'),
        [descriptorOf],
    );

    const viewOf = React.useCallback((draft: InlineCommentDraft): RowView => {
        switch (draft.source) {
            case 'chat-quote': {
                const quote = quoteDisplayText(draft.code);
                return {
                    icon: 'chat-1',
                    title: t('chat.message.context.chatQuote'),
                    snippet: firstLine(quote),
                    quote,
                    mono: false,
                    comment: draft.text,
                    editable: true,
                };
            }
            case 'terminal': {
                const title = t('chat.chatInput.terminalContext', { terminal: draft.fileLabel, start: draft.startLine, end: draft.endLine });
                return { icon: 'terminal', title, snippet: title, quote: draft.code, mono: true, comment: '', editable: false };
            }
            case 'preview-annotation': {
                const annotation = readBrowserAnnotationPrompt(draft.code);
                return {
                    icon: 'global',
                    title: t('chat.message.context.browserAnnotation', { page: draft.fileLabel }),
                    snippet: annotation.texts[0] ?? annotation.page ?? draft.fileLabel,
                    quote: annotation.texts.join('\n') || annotation.page || '',
                    mono: false,
                    comment: draft.text || annotation.comment || '',
                    editable: true,
                };
            }
            case 'pr-comment': {
                const title = t(changeRequestCopy('chat.message.context.prComment', termOf(draft)), { label: draft.fileLabel });
                return { icon: 'git-pull-request', title, snippet: firstLine(draft.code) || title, quote: draft.code, mono: true, comment: draft.text, editable: true };
            }
            case 'pr-check': {
                const title = t(changeRequestCopy('chat.message.context.prCheck', termOf(draft)), { label: draft.fileLabel });
                return { icon: 'close-circle', iconClassName: 'text-[var(--status-error)]', title, snippet: title, quote: draft.code, mono: true, comment: draft.text, editable: true };
            }
            case 'file-quote': {
                const file = basename(draft.fileLabel);
                const title = draft.startLine > 0 && draft.endLine > 0
                    ? (draft.startLine === draft.endLine
                        ? t('chat.message.context.codeCommentLine', { file, line: draft.startLine })
                        : t('chat.message.context.codeComment', { file, start: draft.startLine, end: draft.endLine }))
                    : t('chat.message.context.fileQuote', { file });
                return { icon: 'file-text', title, snippet: location(file, draft.startLine, draft.endLine), quote: draft.code, mono: false, comment: draft.text, editable: true };
            }
            default: {
                const file = fileWithDiffCommentOrigin(basename(draft.fileLabel), draft.origin);
                const wholeFile = isWholeFileComment(draft);
                const title = wholeFile
                    ? t('chat.message.context.codeCommentFile', { file })
                    : draft.startLine === draft.endLine
                    ? t('chat.message.context.codeCommentLine', { file, line: draft.startLine })
                    : t('chat.message.context.codeComment', { file, start: draft.startLine, end: draft.endLine });
                return {
                    icon: 'code-sslash',
                    title,
                    snippet: wholeFile ? file : location(file, draft.startLine, draft.endLine),
                    quote: draft.code,
                    mono: true,
                    comment: draft.text,
                    editable: true,
                };
            }
        }
    }, [t, termOf]);

    const quoteMarks = React.useMemo<ChatQuoteMark[]>(() => {
        if (!draftTarget) return [];
        return drafts.flatMap((draft) => (
            draft.source === 'chat-quote' && draft.fileLabel
                ? [{
                    id: draft.id,
                    messageId: draft.fileLabel,
                    anchor: draft.anchor ?? legacyChatQuoteAnchor(draft.code),
                    comment: draft.text,
                    updateComment: (text: string) => updateDraft(draftTarget, draft.id, { text }),
                    remove: () => removeDraft(draftTarget, draft.id),
                }]
                : []
        ));
    }, [draftTarget, drafts, removeDraft, updateDraft]);
    React.useEffect(() => {
        if (!quoteHighlights) return;
        quoteHighlights.publishMarks(quotePublisher, quoteMarks);
        return () => quoteHighlights.publishMarks(quotePublisher, []);
    }, [quoteHighlights, quoteMarks, quotePublisher]);

    const composingDraftId = surfaceActive
        ? drafts.filter((draft) => draft.composing).at(-1)?.id ?? null
        : null;
    const openDraftId = composingDraftId ?? openId;

    const { visible: visibleDrafts, hiddenCount } = foldContextRows(drafts, {
        limit: VISIBLE_ROWS,
        showAll,
        keepId: composingDraftId,
    });

    React.useEffect(() => {
        if (composingDraftId && openId && openId !== composingDraftId) setOpenId(null);
        if (openDraftId && !visibleDrafts.some((draft) => draft.id === openDraftId)) setOpenId(null);
    }, [composingDraftId, openId, openDraftId, visibleDrafts]);
    React.useEffect(() => {
        if (drafts.length <= VISIBLE_ROWS) setShowAll(false);
    }, [drafts.length]);

    React.useEffect(() => {
        if (!openDraftId) return;
        const handlePointerDown = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is always a Node; `contains` only needs that.
            if (listRef.current?.contains(event.target as Node)) return;
            if (openRowEditsRef.current && listRef.current?.contains(document.activeElement)) return;
            setOpenId(null);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [openDraftId]);

    if (!draftTarget || drafts.length === 0) return null;

    const saveComment = (draft: InlineCommentDraft, text: string): boolean => {
        const legacyAnnotationComment = draft.source === 'preview-annotation' && readBrowserAnnotationPrompt(draft.code).comment !== null;
        return updateDraft(draftTarget, draft.id, legacyAnnotationComment
            ? { text, code: withoutBrowserAnnotationComment(draft.code) }
            : { text });
    };

    const removeScreenshotFile = (draft: InlineCommentDraft) => {
        const screenshot = draft.screenshot ? attachedFiles.find((file) => file.filename === draft.screenshot) : undefined;
        if (screenshot) removeAttachedFile(screenshot.id);
    };

    const toggle = (draft: InlineCommentDraft, view: RowView) => {
        if (openDraftId === draft.id) {
            setOpenId(null);
            return;
        }
        if (isMobile && mobileComment && view.editable) {
            if (draft.source === 'preview-annotation' && !draft.text && readBrowserAnnotationPrompt(draft.code).comment !== null) {
                saveComment(draft, view.comment);
            }
            flushSync(() => mobileComment.openEdit({
                target: draftTarget,
                draftId: draft.id,
                quote: { plainText: view.quote.trim() ? view.quote : view.title, markdownText: view.quote, messageId: null },
                text: view.comment,
            }));
            return;
        }
        setOpenId(draft.id);
    };

    const editsInPlace = !isMobile || !mobileComment;
    const openDraft = openDraftId ? visibleDrafts.find((draft) => draft.id === openDraftId) : undefined;
    openRowEditsRef.current = Boolean(openDraft && editsInPlace && viewOf(openDraft).editable);

    const rows = visibleDrafts.map((draft) => {
        const view = viewOf(draft);
        const revealable = quoteHighlights && draft.source === 'chat-quote' && draft.fileLabel;
        return (
            <DraftRow
                key={draft.id}
                draft={draft}
                view={view}
                open={openDraftId === draft.id}
                editsInPlace={editsInPlace}
                phoneLayout={isMobile}
                onToggle={() => toggle(draft, view)}
                onClose={() => setOpenId((current) => (current === draft.id ? null : current))}
                onRemove={() => {
                    quoteHighlights?.focusMark(null);
                    removeDraft(draftTarget, draft.id);
                    removeScreenshotFile(draft);
                }}
                onRemoveScreenshot={() => {
                    if (!updateDraft(draftTarget, draft.id, { screenshot: undefined, code: withoutBrowserAnnotationScreenshot(draft.code) })) return;
                    removeScreenshotFile(draft);
                }}
                onSaveComment={(text) => saveComment(draft, text)}
                composing={draft.composing === true}
                onComposeText={(text) => updateDraft(draftTarget, draft.id, { text })}
                onComposeFinish={() => {
                    const stored = useInlineCommentDraftStore.getState().getDrafts(draftTarget).find((item) => item.id === draft.id);
                    if (!stored?.text.trim()) removeDraft(draftTarget, draft.id);
                    else updateDraft(draftTarget, draft.id, { composing: false });
                }}
                onComposeCancel={() => removeDraft(draftTarget, draft.id)}
                onFocusQuote={quoteHighlights && draft.source === 'chat-quote'
                    ? (focused) => quoteHighlights.focusMark(focused ? draft.id : null)
                    : null}
                onRevealQuote={revealable
                    ? () => quoteHighlights.reveal(draft.fileLabel, draft.anchor ?? legacyChatQuoteAnchor(draft.code))
                    : null}
                attachmentFilenames={attachmentFilenames}
                onOpenScreenshot={draft.screenshot && attachmentFilenames.includes(draft.screenshot) ? () => onOpenAttachment(draft.screenshot ?? '') : null}
            />
        );
    });

    return (
        <div ref={listRef} className="pt-1.5">
            <ScrollableOverlay outerStyle={{ maxHeight: '40vh' }} className="flex flex-col gap-0.5" disableHorizontal>
                {rows}
            </ScrollableOverlay>
            {hiddenCount > 0 || showAll ? (
                <button
                    type="button"
                    className="ms-1.5 py-0.5 typography-micro text-muted-foreground transition-colors hover:text-foreground"
                    style={{ minHeight: 0, minWidth: 0 }}
                    onClick={() => setShowAll((value) => !value)}
                >
                    {showAll ? t('chat.chatInput.context.showLess') : t('chat.chatInput.context.more', { count: hiddenCount })}
                </button>
            ) : null}
        </div>
    );
}

export const ComposerContextRows = React.memo(ComposerContextRowsView);
