export type ComposerAbortSurface = 'main' | 'mini-chat' | 'btw' | 'unknown';

export const isTouchOnlyInput = (): boolean => (
    window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches === true
);

export const abortShortcutReachesComposer = ({ surface, touch }: { surface: ComposerAbortSurface; touch: boolean }): boolean => (
    !touch && (surface === 'main' || surface === 'mini-chat')
);
