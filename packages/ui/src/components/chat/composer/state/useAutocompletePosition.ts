/**
 * Where the composer's autocomplete popup goes: at the caret, as every text
 * field's suggestions are (`components/inline-picker`). It rises right above
 * the line being typed, starting at the trigger, inside the composer's width,
 * and may reach up over the transcript; below the line only when there is
 * clearly more room there, as near the top of the screen.
 *
 * On the phone the list takes the composer's whole width, as the screen is
 * narrow and rows are tapped, still right above the line being typed: it covers
 * the composer's earlier lines rather than leaving them between the list and
 * the text.
 */

import React from 'react';

import { placeCaretPopup, samePlacement, viewportLimits } from '@/components/inline-picker/placement';
import { isRightToLeft } from '@/lib/i18n';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import type { AutocompleteKind } from '../language/triggers';
import type { AutocompleteOverlayPosition } from '../ui/ComposerAutocompletePopups';

/**
 * Widths each picker asks for when placed at the caret; a narrower composer
 * narrows them. One width for every list, so they read as one family; the
 * mention list, which also shows file paths, is wider, and the emoji list,
 * whose rows are a glyph and a short name, narrower.
 */
const CARET_PLACED_WIDTH = {
    mention: 560,
    command: 420,
    snippet: 420,
    skill: 420,
    emoji: 280,
} as const satisfies Record<AutocompleteKind, number>;

export interface AutocompletePositionOptions {
    /** The phone: the list takes the composer's whole width. */
    fullWidth: boolean;
    openAutocomplete: AutocompleteKind | null;
    /** The text after the trigger, which places the trigger before the caret. */
    query: string;
    /** Recompute whenever the text changes, since the caret moves with it. */
    message: string;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    /** The composer box the popup is positioned within. */
    containerRef: React.RefObject<HTMLElement | null>;
}

export function useAutocompletePosition(options: AutocompletePositionOptions) {
    const { fullWidth, openAutocomplete, query, message, editorRef, containerRef } = options;
    const [position, setPosition] = React.useState<AutocompleteOverlayPosition | null>(null);

    const update = React.useCallback(() => {
        if (openAutocomplete === null) {
            setPosition(null);
            return;
        }
        const editor = editorRef.current;
        const container = containerRef.current;
        if (!editor || !container) return;

        // Anchored at the trigger, the popup stays put while its query grows.
        const caret = editor.getSelection().start;
        const caretCoords = editor.caretCoords(Math.max(0, caret - query.length - 1)) ?? editor.caretCoords();
        if (!caretCoords) return;
        // Below, the list clears the line the caret is on now: a long query may have wrapped.
        const caretBottom = editor.caretCoords()?.bottom ?? caretCoords.bottom;

        const box = container.getBoundingClientRect();
        // Up to the top of the chat area, never under the app header; down to
        // the top of the phone's keyboard, which covers the page without
        // shrinking the window, so the window's height would count room
        // under it and drop a list there out of sight.
        const visible = viewportLimits();
        const limits = { top: Math.max(container.closest('main')?.getBoundingClientRect().top ?? 0, visible.top), bottom: visible.bottom };
        const placement = placeCaretPopup({
            caret: caretCoords,
            caretBottom,
            bounds: box,
            limits,
            width: fullWidth ? box.width : CARET_PLACED_WIDTH[openAutocomplete],
            rightToLeft: isRightToLeft(container),
        });
        const next = {
            top: placement.top - box.top,
            place: placement.place,
            left: placement.left - box.left,
            width: placement.width,
            maxHeight: placement.maxHeight,
        };
        // Scrolls anywhere land here (a streaming reply scrolls all the time);
        // one that moved nothing must not re-render the composer.
        setPosition((current) => (current && samePlacement(current, next) ? current : next));
    }, [containerRef, editorRef, fullWidth, openAutocomplete, query]);

    React.useLayoutEffect(() => {
        update();
    }, [update, message]);

    React.useEffect(() => {
        if (openAutocomplete === null) return;
        // The phone's keyboard moves the visual viewport, not the window.
        window.visualViewport?.addEventListener('resize', update);
        window.visualViewport?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.visualViewport?.removeEventListener('resize', update);
            window.visualViewport?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [openAutocomplete, update]);

    return { position, update };
}
