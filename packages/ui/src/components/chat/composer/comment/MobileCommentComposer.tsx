/**
 * The mobile composer's comment mode: one rounded shell replacing the normal
 * composer while a comment on a quoted selection is written. The quote row
 * shows a single-line quote preview; the comment editor, a comment-scoped mic and
 * the attach button sit below. Attach is the only primary action. The parent
 * remounts this shell per comment (keyed by generation), so a replaced open
 * gets fresh dictation callbacks and cannot target the previous quote.
 */

import React from 'react';

import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Theme } from '@/types/theme';
import { composerAutoCorrect } from '../editor/autocorrect';
import { ComposerEditor, type ComposerEditorHandle } from '../editor/ComposerEditor';
import type { ComposerLanguageContext } from '../language/tokenize';
import { mobileCommentQuotePreview, type MobileCommentDraft } from './mobileCommentDraft';

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** Comments are plain prose: nothing in the prompt language resolves here. */
const COMMENT_LANGUAGE_CONTEXT: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: EMPTY_NAMES,
    confirmedMentions: EMPTY_NAMES,
    knownSlashNames: EMPTY_NAMES,
    knownSnippetTriggers: EMPTY_NAMES,
    attachmentFilenames: [],
};

const MOBILE_COMMENT_RADIUS = '1.5rem';
const MOBILE_COMMENT_MAX_LINES = 6;
const FOOTER_ICON_BUTTON_CLASS = 'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-foreground outline-none focus:outline-none';
const FOOTER_PADDING_CLASS = 'px-1.5 py-1.5';
const ICON_SIZE_CLASS = 'h-[18px] w-[18px]';
const SEND_ICON_SIZE_CLASS = 'h-4 w-4';
/** Width of the trailing fade on the quote preview. */
const PREVIEW_FADE_PX = 20;

const previewFadeStyle = (): React.CSSProperties => ({
    maskImage: `linear-gradient(to right, black calc(100% - ${PREVIEW_FADE_PX}px), transparent)`,
    WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${PREVIEW_FADE_PX}px), transparent)`,
});

export interface MobileCommentComposerHandlers {
    onTextChange(text: string): void;
    onCancel(): void;
    onAttach(): void;
    onDictationInsert(text: string): void;
    /** Insert-and-send in comment mode attaches the comment; it never sends. */
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

    // The opening tap flushes the controller update through React before it
    // returns, so this focus still runs inside the gesture's call stack — the
    // only focus iOS raises the soft keyboard for.
    React.useLayoutEffect(() => {
        editorRef.current?.focus();
    }, []);

    // Let the available row width clip long quotes, with a fade before Close.
    const quotePreview = mobileCommentQuotePreview(draft.quote.plainText);

    return (
        <div
            data-mobile-comment-composer="true"
            className="relative flex flex-col rounded-[1.5rem] border border-border/80 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]"
            style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
        >
            <div className="flex items-center gap-2 pl-3.5 pr-1.5 pt-2">
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
                    className="ml-auto size-8 shrink-0 text-muted-foreground"
                    onClick={handlers.onCancel}
                    title={t('mobile.surface.closeAria')}
                    aria-label={t('mobile.surface.closeAria')}
                >
                    <Icon name="close" className={cn(ICON_SIZE_CLASS, 'text-current')} />
                </Button>
            </div>
            <div className="flex items-end gap-1 pb-1 pl-1 pr-1.5">
                <ComposerEditor
                    ref={editorRef}
                    data-testid="mobile-comment-input"
                    dataChatInput="comment"
                    value={draft.text}
                    languageContext={COMMENT_LANGUAGE_CONTEXT}
                    onChange={(change) => handlers.onTextChange(change.value)}
                    onFocus={handlers.onEditorFocus}
                    onBlur={handlers.onEditorBlur}
                    placeholder={t('chat.textSelection.comment.placeholder')}
                    editable
                    autoCorrect={composerAutoCorrect({ isMobile: true })}
                    autoCapitalize="sentences"
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
                    title={t('chat.textSelection.comment.attach')}
                    aria-label={t('chat.textSelection.comment.attach')}
                >
                    <Icon name="attachment-2" className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}
