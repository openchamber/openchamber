import React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type LargeTextPasteChoiceAction = 'attach' | 'inline';

type LargeTextPasteChoiceProps = {
    /** Desktop: the choice takes focus so the keyboard answers it. Mobile keeps the editor focused, or the keyboard closes. */
    takeFocus: boolean;
    /** `explicitlyChosen` is false when focus left for somewhere else and the paste went inline by default. */
    onChoose: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean) => void;
    /** A printable key pressed while the choice has focus: paste inline, then type it. */
    onTypeThrough: (text: string) => void;
};

const buttonClassName = cn(
    'px-3.5 py-1.5 rounded-full outline-none',
    'text-sm font-medium text-foreground',
    'hover:bg-[var(--interactive-hover)]',
    'focus:bg-[var(--interactive-selection)] focus:text-[var(--interactive-selection-foreground)]',
    'transition-colors duration-150',
);

/**
 * Asks how a large paste lands, right above the composer. Styled like the
 * chat's text-selection menu. Enter picks the focused option, arrows or Tab
 * switch, Escape and typing on paste inline.
 */
export const LargeTextPasteChoice: React.FC<LargeTextPasteChoiceProps> = ({ takeFocus, onChoose, onTypeThrough }) => {
    const { t } = useI18n();
    const attachRef = React.useRef<HTMLButtonElement>(null);
    const inlineRef = React.useRef<HTMLButtonElement>(null);

    React.useEffect(() => {
        if (takeFocus) attachRef.current?.focus({ preventScroll: true });
    }, [takeFocus]);

    const focusedAction = (): LargeTextPasteChoiceAction => (
        document.activeElement === inlineRef.current ? 'inline' : 'attach'
    );

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.nativeEvent.isComposing) return;
        const { key } = event;
        if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab') {
            // Two options: every step lands on the other one, in either direction.
            (focusedAction() === 'attach' ? inlineRef : attachRef).current?.focus();
        } else if (key === 'Enter') {
            onChoose(focusedAction(), true);
        } else if (key === 'Escape') {
            onChoose('inline', true);
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            onTypeThrough(key);
        } else {
            return;
        }
        // The composer form and global shortcuts must not act on these keys too.
        event.preventDefault();
        event.stopPropagation();
    };

    const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
        if (!takeFocus) return;
        if (event.currentTarget.contains(event.relatedTarget)) return;
        // Switching to another window is not an answer; the choice waits.
        if (!document.hasFocus()) return;
        onChoose('inline', false);
    };

    return (
        <div
            role="group"
            aria-label={t('chat.chatInput.largeTextPaste.title')}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            // Taps keep focus where it is, so the mobile keyboard stays up.
            onMouseDown={(event) => event.preventDefault()}
            className={cn(
                'absolute bottom-full inset-s-3 z-50 mb-2',
                'flex items-center whitespace-nowrap',
                'oc-glass-popover oc-glass-floating rounded-full',
                'p-1',
            )}
        >
            <button ref={attachRef} type="button" className={buttonClassName} onClick={() => onChoose('attach', true)}>
                {t('chat.chatInput.largeTextPaste.attach')}
            </button>
            <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />
            <button ref={inlineRef} type="button" className={buttonClassName} onClick={() => onChoose('inline', true)}>
                {t('chat.chatInput.largeTextPaste.inline')}
            </button>
        </div>
    );
};
