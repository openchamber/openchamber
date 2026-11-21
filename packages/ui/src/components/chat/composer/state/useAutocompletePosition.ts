
import React from 'react';

import { placeCaretPopup, samePlacement, viewportLimits } from '@/components/inline-picker/placement';
import { isRightToLeft } from '@/lib/i18n';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import type { AutocompleteKind } from '../language/triggers';
import type { AutocompleteOverlayPosition } from '../ui/ComposerAutocompletePopups';
import type { ComposerText } from './composerText';

const MENTION_LIST_WIDTH = 560;

const CARET_PLACED_WIDTH = {
    mention: MENTION_LIST_WIDTH,
    command: MENTION_LIST_WIDTH,
    snippet: 420,
    skill: 420,
    emoji: 280,
} as const satisfies Record<AutocompleteKind, number>;

export interface AutocompletePositionOptions {
    fullWidth: boolean;
    openAutocomplete: AutocompleteKind | null;
    query: string;
    text: ComposerText;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    containerRef: React.RefObject<HTMLElement | null>;
}

export function useAutocompletePosition(options: AutocompletePositionOptions) {
    const { fullWidth, openAutocomplete, query, text, editorRef, containerRef } = options;
    const [position, setPosition] = React.useState<AutocompleteOverlayPosition | null>(null);

    const update = React.useCallback(() => {
        if (openAutocomplete === null) {
            setPosition(null);
            return;
        }
        const editor = editorRef.current;
        const container = containerRef.current;
        if (!editor || !container) return;

        const caret = editor.getSelection().start;
        const caretCoords = editor.caretCoords(Math.max(0, caret - query.length - 1)) ?? editor.caretCoords();
        if (!caretCoords) return;
        const caretBottom = editor.caretCoords()?.bottom ?? caretCoords.bottom;

        const box = container.getBoundingClientRect();
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
        setPosition((current) => (current && samePlacement(current, next) ? current : next));
    }, [containerRef, editorRef, fullWidth, openAutocomplete, query]);

    React.useLayoutEffect(() => {
        update();
        if (openAutocomplete === null) return;
        return text.subscribe(update);
    }, [openAutocomplete, text, update]);

    React.useEffect(() => {
        if (openAutocomplete === null) return;
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
