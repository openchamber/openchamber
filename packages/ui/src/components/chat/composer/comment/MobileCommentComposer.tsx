
import React from 'react';

import { useCommentEnterSubmit } from '@/components/comments/useCommentEnterSubmit';
import { useCommentFieldPicker } from '@/components/comments/useCommentFieldPicker';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import type { Theme } from '@/types/theme';
import { composerAutoCorrect } from '../editor/autocorrect';
import { ComposerEditor, type ComposerEditorHandle } from '../editor/ComposerEditor';
import type { ComposerLanguageContext } from '../language/tokenize';
import { mobileCommentQuotePreview, type MobileCommentDraft } from './mobileCommentDraft';

const EMPTY_NAMES: ReadonlySet<string> = new Set();

const commentLanguageContext = (knownSnippetTriggers: ReadonlySet<string>): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: EMPTY_NAMES,
    confirmedMentions: EMPTY_NAMES,
    knownSlashNames: EMPTY_NAMES,
    knownSnippetTriggers,
    attachmentFilenames: [],
});

const MOBILE_COMMENT_RADIUS = '1.25rem';
const MOBILE_COMMENT_MAX_LINES = 6;
const FOOTER_ICON_BUTTON_CLASS = 'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-foreground outline-none focus:outline-none';
const FOOTER_PADDING_CLASS = 'px-1.5 py-1.5';
const ICON_SIZE_CLASS = 'h-[18px] w-[18px]';
const SEND_ICON_SIZE_CLASS = 'h-4 w-4';
const PREVIEW_FADE_PX = 20;

const previewFadeStyle = (): React.CSSProperties => ({
    maskImage: `linear-gradient(var(--oc-to-inline-end), black calc(100% - ${PREVIEW_FADE_PX}px), transparent)`,
    WebkitMaskImage: `linear-gradient(var(--oc-to-inline-end), black calc(100% - ${PREVIEW_FADE_PX}px), transparent)`,
});

export interface MobileCommentComposerHandlers {
    onTextChange(text: string): void;
    onCancel(): void;
    onAttach(): void;
    onDictationInsert(text: string): void;
    onDictationInsertAndSend(text: string): void;
    onEditorFocus(): void;
    onEditorBlur(): void;
    onDictationActiveChange(active: boolean): void;
}

export interface MobileCommentComposerProps {
    draft: Extract<MobileCommentDraft, { status: 'open' }>;
    theme: Theme;
    handlers: MobileCommentComposerHandlers;
}

export function MobileCommentComposer({ draft, theme: currentTheme, handlers }: MobileCommentComposerProps) {
    const { t } = useI18n();
    const editorRef = React.useRef<ComposerEditorHandle>(null);
    const snippets = useSnippetsStore((state) => state.snippets);
    const commentKeys = useCommentEnterSubmit();
    const languageContext = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of snippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return commentLanguageContext(triggers);
    }, [snippets]);
    const getCaret = React.useCallback(() => editorRef.current?.getSelection().start ?? 0, []);
    const replaceRange = React.useCallback((from: number, to: number, insert: string) => {
        editorRef.current?.replaceRange(from, to, insert);
        editorRef.current?.focus();
    }, []);
    const caretCoords = React.useCallback((position: number) => editorRef.current?.caretCoords(position) ?? null, []);
    const fieldPicker = useCommentFieldPicker({ text: draft.text, getCaret, replaceRange, caretCoords });

    const handleKeyDown = (event: KeyboardEvent): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (fieldPicker.handleKeyDown(event)) return true;
        if (event.key === 'Enter' && commentKeys.shouldSubmit(event)) {
            event.preventDefault();
            handlers.onAttach();
            return true;
        }
        return false;
    };

    React.useLayoutEffect(() => {
        editorRef.current?.focus();
        if (draft.text) editorRef.current?.setSelection(draft.text.length);
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const quotePreview = mobileCommentQuotePreview(draft.quote.plainText);
    const editing = Boolean(draft.draftId);
    const closeLabel = editing ? t('chat.chatInput.contextPreview.cancelEdit') : t('mobile.surface.closeAria');
    const primaryLabel = editing ? t('chat.textSelection.comment.save') : t('chat.textSelection.comment.attach');

    return (
        <div
            data-mobile-comment-composer="true"
            data-composer-transient=""
            className="relative flex flex-col rounded-[1.25rem] border border-edge shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]"
            style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
        >
            <div className="flex items-center gap-2 ps-3.5 pe-1.5 pt-2">
                <Icon name="double-quotes-l" className={cn(ICON_SIZE_CLASS, 'shrink-0 text-muted-foreground')} />
                <span
                    className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm leading-5 text-muted-foreground"
                    style={previewFadeStyle()}
                >
                    {quotePreview}
                </span>
                <Button
                    variant="ghost"
                    size="icon"
                    className="ms-auto size-8 shrink-0 text-muted-foreground"
                    onClick={handlers.onCancel}
                    title={closeLabel}
                    aria-label={closeLabel}
                >
                    <Icon name="close" className={cn(ICON_SIZE_CLASS, 'text-current')} />
                </Button>
            </div>
            <div className="relative flex items-end gap-1 pb-1 ps-1 pe-1.5">
                {fieldPicker.picker}
                <ComposerEditor
                    ref={editorRef}
                    scriptAwareWords
                    data-testid="mobile-comment-input"
                    dataChatInput="comment"
                    value={draft.text}
                    languageContext={languageContext}
                    onChange={(change) => {
                        handlers.onTextChange(change.value);
                        fieldPicker.sync(change.value, change.selection.start, !change.fromPaste && !change.fromValueProp);
                    }}
                    onSelectionChange={(selection) => fieldPicker.sync(editorRef.current?.getValue() ?? draft.text, selection.start, false)}
                    onKeyDown={handleKeyDown}
                    onFocus={handlers.onEditorFocus}
                    onBlur={handlers.onEditorBlur}
                    placeholder={t('chat.textSelection.comment.placeholder')}
                    editable
                    autoCorrect={composerAutoCorrect({ isMobile: true })}
                    autoCapitalize="sentences"
                    preserveDeferredEnterShift={commentKeys.preserveDeferredEnterShift}
                    returnKeySends={commentKeys.returnKeySends}
                    spellCheck
                    maxLines={MOBILE_COMMENT_MAX_LINES}
                    className="min-h-[44px] flex-1 px-2.5 py-2 typography-markdown"
                />
                <div className="mb-1 flex h-9 shrink-0 items-center">
                    <ComposerDictation
                        radius={MOBILE_COMMENT_RADIUS}
                        isMobile
                        footerIconButtonClass={FOOTER_ICON_BUTTON_CLASS}
                        footerPaddingClass={FOOTER_PADDING_CLASS}
                        iconSizeClass={ICON_SIZE_CLASS}
                        sendIconSizeClass={SEND_ICON_SIZE_CLASS}
                        onInsert={handlers.onDictationInsert}
                        onInsertAndSend={handlers.onDictationInsertAndSend}
                        onActiveChange={handlers.onDictationActiveChange}
                    />
                </div>
                <Button
                    variant="default"
                    size="icon"
                    className="mb-1 shrink-0 rounded-full border-0 [corner-shape:round] transition-opacity hover:opacity-90 active:opacity-80"
                    style={{ backgroundColor: 'var(--primary-base)', color: 'var(--primary-foreground)' }}
                    onClick={handlers.onAttach}
                    title={primaryLabel}
                    aria-label={primaryLabel}
                >
                    <Icon name={editing ? 'check' : 'attachment-2'} className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
