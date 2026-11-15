/**
 * Context waiting for the next message, as rows inside the composer above the
 * input: review comments left in a diff, preview annotations, terminal
 * selections, PR context, chat quotes.
 *
 * Each row reads like the sent message will: the quoted material behind an
 * accent bar, then the user's comment. A click opens the row in place, with
 * the whole quote and the comment ready to edit; Enter or a click elsewhere
 * saves, Escape drops the edit. On mobile the click opens the composer's
 * comment shell on that comment instead (`composer/comment/`), the same field
 * that wrote it. Remove and "show in the original message" wait on the row's
 * hover, and stay visible on touch screens.
 */

import React from 'react';
import { flushSync } from 'react-dom';

import { CommentTextEditor } from '@/components/comments/CommentTextEditor';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { readBrowserAnnotationPrompt, withoutBrowserAnnotationComment } from '@/lib/browser/annotationPrompt';
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

interface ComposerContextRowsProps {
    draftTarget: InlineCommentDraftTarget | null;
    /** Mobile edits a comment in the composer's comment shell, not in the row. */
    isMobile: boolean;
    /** Opens one of the composer's files by name: a browser annotation's screenshot. */
    onOpenAttachment: (filename: string) => void;
}

/** Rows shown before the rest folds behind "+N more", so the input keeps its place. */
const VISIBLE_ROWS = 4;

/** The bar every quote stands behind, here and in the sent message. */
const QUOTE_BAR_CLASS = 'border-s-3 border-primary/45 ps-2.5';

/**
 * A collapsed comment's text before a chip keeps its width, up to a cap past
 * which it truncates: the chip and the line's tail give way first. Shrinking it
 * even by a fraction of a pixel would put an ellipsis on a word that fits.
 */
const LEADING_TEXT_STYLE: React.CSSProperties = { flexShrink: 0, maxWidth: '60%', whiteSpace: 'pre' };
/** `truncate` collapses the spaces at a run's edges, which sit right against a chip. */
const TEXT_RUN_STYLE: React.CSSProperties = { whiteSpace: 'pre' };

const ROW_ACTION_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground';

/** What a row shows for one draft. */
type RowView = {
    icon: IconName;
    iconClassName?: string;
    /** The source, named in full: the caption of the open row and the row's tooltip. */
    title: string;
    /** The collapsed row's lead: the quote's first line, or where it came from. */
    snippet: string;
    /** The open row's quote. */
    quote: string;
    /** Code, terminal output and CI logs read better monospaced. */
    mono: boolean;
    comment: string;
    editable: boolean;
};

const basename = (path: string): string => {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** `file:12`, `file:12-18`, or the file alone for a whole-file comment. */
const location = (file: string, start: number, end: number): string => {
    if (start <= 0) return file;
    return start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
};

const DraftRow: React.FC<{
    draft: InlineCommentDraft;
    view: RowView;
    open: boolean;
    /** Desktop: an open editable row is an open editor. */
    editsInPlace: boolean;
    /**
     * The phone layout: no hover whatever the pointer, so the actions stay
     * visible, and a folded row with a comment shows only the comment, since
     * the quote beside it would leave a few words of each.
     */
    phoneLayout: boolean;
    onToggle: () => void;
    onClose: () => void;
    onRemove: () => void;
    onSaveComment: (text: string) => boolean;
    onFocusQuote: ((focused: boolean) => void) | null;
    onRevealQuote: (() => void) | null;
    attachmentFilenames: readonly string[];
    /** Opens the annotation's screenshot; absent when the row has none. */
    onOpenScreenshot: (() => void) | null;
}> = ({ draft, view, open, editsInPlace, phoneLayout, onToggle, onClose, onRemove, onSaveComment, onFocusQuote, onRevealQuote, attachmentFilenames, onOpenScreenshot }) => {
    const { t } = useI18n();
    const [editText, setEditText] = React.useState(view.comment);
    // Images pasted while editing join the composer's attachments on save.
    const imagePaste = useCommentImagePaste();
    const editing = open && editsInPlace && view.editable;

    // Set once the edit is saved, dropped or the item removed, so a blur that
    // follows (the field unmounting) does nothing more.
    const settledRef = React.useRef(false);
    React.useEffect(() => {
        if (!editing) return;
        settledRef.current = false;
        setEditText(view.comment);
        // The comment at edit start is the baseline; later store updates are our own saves.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
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
    // A blur saves once focus has really left the row, whether the row is
    // still open or another row's click already replaced it. The field also
    // blurs when it remounts (React's development double mount removes the
    // first one) while the second field takes focus right after: that blur
    // finds focus back inside the row and saves nothing.
    const openRowRef = React.useRef<HTMLDivElement>(null);
    const handleRowBlur = () => {
        const row = openRowRef.current;
        window.setTimeout(() => {
            if (row?.isConnected && row.contains(document.activeElement)) return;
            commitEdit();
        }, 0);
    };
    // A press on the row's own controls keeps focus in the field, so its blur
    // does not save and close the row under the pointer first.
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
            {/* An open row's quote is itself the way to its source. */}
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
                        // Text runs and file chips share the line and shrink together, so a
                        // chip narrows to its icon and the start of its name instead of
                        // being cut off whole the way one line's ellipsis would.
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
            // Focus leaving the row from anywhere inside it (the field, or the
            // row's buttons the keyboard moved to) saves the edit.
            onBlur={editing ? handleRowBlur : undefined}
            {...focusHandlers}
        >
            <div
                className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                role="button"
                tabIndex={0}
                aria-expanded
                onPointerDown={keepEditorFocus}
                onClick={editing ? commitEdit : onToggle}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (editing) commitEdit();
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
                <button
                    type="button"
                    className={cn(INLINE_REFERENCE_CHIP_CLASS, 'mx-1.5 mt-1.5 cursor-pointer transition-colors hover:border-foreground/40')}
                    style={{ minHeight: 0, minWidth: 0 }}
                    onPointerDown={keepEditorFocus}
                    onClick={onOpenScreenshot}
                    title={draft.screenshot}
                >
                    <FileTypeIcon filePath={draft.screenshot} className="h-[1.1em] w-[1.1em] shrink-0" />
                    <span className={REFERENCE_CHIP_LABEL_CLASS}>{draft.screenshot}</span>
                </button>
            ) : null}
            {editing ? (
                <CommentTextEditor
                    value={editText}
                    onChange={setEditText}
                    onSubmit={commitEdit}
                    onCancel={cancelEdit}
                    enterSubmits
                    imagePaste={imagePaste}
                    placeholder={t('chat.textSelection.comment.placeholder')}
                    aria-label={view.title}
                    // The comment turns editable where it sits, with no field around it.
                    className="mx-1.5 mt-1.5 text-sm leading-5 text-foreground"
                />
            ) : view.comment.trim() ? (
                <div dir="auto" className="mx-1.5 mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
                    {withAttachmentChips(view.comment, attachmentFilenames, `row-${draft.id}`)}
                </div>
            ) : null}
        </div>
    );
};

function ComposerContextRowsView({ draftTarget, isMobile, onOpenAttachment }: ComposerContextRowsProps) {
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
    // A draft without a provider was written before providers other than GitHub existed: a pull request.
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
                // The prompt is written for the model; the row shows what the user pointed at.
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

    // Quotes waiting here stay marked in their messages until sent or removed.
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

    const hiddenCount = showAll ? 0 : Math.max(0, drafts.length - VISIBLE_ROWS);
    const visibleDrafts = hiddenCount > 0 ? drafts.slice(0, VISIBLE_ROWS) : drafts;

    // An open row that left the list (removed, sent, folded away) is closed.
    React.useEffect(() => {
        if (openId && !visibleDrafts.some((draft) => draft.id === openId)) setOpenId(null);
    }, [openId, visibleDrafts]);
    React.useEffect(() => {
        if (drafts.length <= VISIBLE_ROWS) setShowAll(false);
    }, [drafts.length]);

    // A press outside the list closes a read-only open row; an editing row
    // closes through its field's blur, which saves first.
    React.useEffect(() => {
        if (!openId) return;
        const handlePointerDown = (event: PointerEvent) => {
            // SAFETY: a pointer event target inside the document is always a Node; `contains` only needs that.
            if (listRef.current?.contains(event.target as Node)) return;
            // An editing row closes through its blur, which saves first.
            if (openRowEditsRef.current && listRef.current?.contains(document.activeElement)) return;
            setOpenId(null);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [openId]);

    if (!draftTarget || drafts.length === 0) return null;

    const saveComment = (draft: InlineCommentDraft, text: string): boolean => {
        // An annotation written before its comment moved out of the prompt
        // still says it there; drop that line so the model reads one comment.
        const legacyAnnotationComment = draft.source === 'preview-annotation' && readBrowserAnnotationPrompt(draft.code).comment !== null;
        return updateDraft(draftTarget, draft.id, legacyAnnotationComment
            ? { text, code: withoutBrowserAnnotationComment(draft.code) }
            : { text });
    };

    const toggle = (draft: InlineCommentDraft, view: RowView) => {
        if (openId === draft.id) {
            setOpenId(null);
            return;
        }
        if (isMobile && mobileComment && view.editable) {
            // The shell saves only the text, so an annotation that still
            // carries its comment in the prompt moves it out first.
            if (draft.source === 'preview-annotation' && !draft.text && readBrowserAnnotationPrompt(draft.code).comment !== null) {
                saveComment(draft, view.comment);
            }
            // flushSync mounts and focuses the shell inside the tap, as iOS
            // requires for the soft keyboard (see composer/comment/).
            flushSync(() => mobileComment.openEdit({
                target: draftTarget,
                draftId: draft.id,
                // Shown in the shell's quote row only; a save writes nothing
                // but the text. Without quoted text the row names the item.
                quote: { plainText: view.quote.trim() ? view.quote : view.title, markdownText: view.quote, messageId: null },
                text: view.comment,
            }));
            return;
        }
        setOpenId(draft.id);
    };

    const editsInPlace = !isMobile || !mobileComment;
    const openDraft = openId ? visibleDrafts.find((draft) => draft.id === openId) : undefined;
    openRowEditsRef.current = Boolean(openDraft && editsInPlace && viewOf(openDraft).editable);

    const rows = visibleDrafts.map((draft) => {
        const view = viewOf(draft);
        const revealable = quoteHighlights && draft.source === 'chat-quote' && draft.fileLabel;
        return (
            <DraftRow
                key={draft.id}
                draft={draft}
                view={view}
                open={openId === draft.id}
                editsInPlace={editsInPlace}
                phoneLayout={isMobile}
                onToggle={() => toggle(draft, view)}
                onClose={() => setOpenId((current) => (current === draft.id ? null : current))}
                onRemove={() => {
                    quoteHighlights?.focusMark(null);
                    removeDraft(draftTarget, draft.id);
                    // The annotation's screenshot leaves with it.
                    const screenshot = draft.screenshot ? attachedFiles.find((file) => file.filename === draft.screenshot) : undefined;
                    if (screenshot) removeAttachedFile(screenshot.id);
                }}
                onSaveComment={(text) => saveComment(draft, text)}
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
            {/* Unfolded, a long list scrolls inside the composer instead of pushing the input off screen. */}
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

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const ComposerContextRows = React.memo(ComposerContextRowsView);
