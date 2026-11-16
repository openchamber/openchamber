/**
 * Whether the abort shortcut (double Escape, `abort_run`) can stop the run of
 * the session a composer writes to. The composer's action button relies on it:
 * while a run is active and a draft is typed, the one disc is Send, and Stop
 * stays reachable only through this shortcut. Where it cannot reach, the
 * composer shows a visible Stop beside the disc instead
 * (ComposerActionButtons). A new surface is `unknown` until its composer is
 * wired to the shortcut, and so keeps the visible Stop.
 *
 * - `main`: the window's chat composer, and a chat pinned in its side panel
 *   (useKeyboardShortcuts through useComposerAbortEscape).
 * - `mini-chat`: Mini Chat's composer (useMiniChatKeyboardShortcuts).
 * - `btw`: BTW's composer, whose Escape collapses BTW; the shortcut skips it.
 * - `unknown`: anything else (the peek surface, a future one).
 */
export type ComposerAbortSurface = 'main' | 'mini-chat' | 'btw' | 'unknown';

/** A device whose only pointer is a finger: it has no Escape key to press. */
export const isTouchOnlyInput = (): boolean => (
    window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches === true
);

export const abortShortcutReachesComposer = ({ surface, touch }: { surface: ComposerAbortSurface; touch: boolean }): boolean => (
    !touch && (surface === 'main' || surface === 'mini-chat')
);
