/**
 * Where an autocomplete popup goes in focus mode.
 *
 * In the normal composer each picker anchors to the composer's own edge, which
 * is close enough to the text. In focus mode the composer fills the surface,
 * so an edge-anchored picker would sit far from what the user is typing —
 * there it follows the caret instead.
 *
 * The editor reports the caret's viewport position directly, so this only has
 * to decide whether the popup fits below the caret or has to flip above it,
 * and keep it inside the composer horizontally.
 */

import React from 'react';

import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import type { AutocompleteKind } from '../language/triggers';
import type { AutocompleteOverlayPosition } from '../ui/ComposerAutocompletePopups';

export interface AutocompletePositionOptions {
    /** Only focus mode places popups at the caret. */
    enabled: boolean;
    openAutocomplete: AutocompleteKind | null;
    /** Recompute whenever the text changes, since the caret moves with it. */
    message: string;
    editorRef: React.RefObject<ComposerEditorHandle | null>;
    /** The composer box the popup is positioned within. */
    containerRef: React.RefObject<HTMLElement | null>;
}

export function useAutocompletePosition(options: AutocompletePositionOptions) {
    const { enabled, openAutocomplete, message, editorRef, containerRef } = options;
    const [position, setPosition] = React.useState<AutocompleteOverlayPosition | null>(null);

const update = React.useCallback(() => {
    if (!enabled) {
        setPosition(null);
        return;
    }

    if (openAutocomplete === null) {
        setPosition(null);
        return;
    }

    const editor = editorRef.current;
    const container = containerRef.current;
    if (!editor || !container) return;

    // The editor reports the caret's viewport position directly, so the
    // popup no longer has to be placed from a hand-measured text mirror.
    const caret = editor.caretCoords();
    if (!caret) return;

    const containerRect = container.getBoundingClientRect();
    const caretY = caret.top - containerRect.top;
    const caretX = caret.left - containerRect.left;

    const popupMargin = 8;
    const estimatedPopupHeight = 260;
    const spaceAbove = caretY - popupMargin;
    const spaceBelow = containerRect.height - caretY - popupMargin;
    const place: 'above' | 'below' = spaceBelow >= estimatedPopupHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

    const desiredWidth = openAutocomplete === 'mention' ? 520 : openAutocomplete === 'skill' ? 360 : 450;
    const clampedLeft = Math.max(
        popupMargin,
        Math.min(caretX - 24, containerRect.width - desiredWidth - popupMargin)
    );

    const maxHeight = Math.max(120, Math.min(estimatedPopupHeight, place === 'below' ? spaceBelow : spaceAbove));

    setPosition({
        top: place === 'below' ? caretY + 22 : caretY - 6,
        left: clampedLeft,
        place,
        maxHeight,
    });
}, [containerRef, editorRef, enabled, openAutocomplete]);

React.useLayoutEffect(() => {
    update();
}, [
    update,
    message,
    openAutocomplete,
    enabled,
]);

React.useEffect(() => {
    if (!enabled) return;
    const onResize = () => update();
    window.addEventListener('resize', onResize);
    return () => {
        window.removeEventListener('resize', onResize);
    };
}, [enabled, update]);

    return { position, update };
}
