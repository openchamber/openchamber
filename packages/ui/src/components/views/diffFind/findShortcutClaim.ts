/**
 * Whether the focused element belongs to *another* surface's editable control —
 * a file editor, the chat composer, a session search box. Those surfaces own
 * Cmd/Ctrl+F while they hold focus, so the diff must leave the key to them.
 *
 * The decision is deliberately DOM-deterministic: focus either sits on an
 * editable control outside `root`, or it does not. It never consults where the
 * last pointer press landed, which made the old rule depend on click history.
 */
export const isForeignEditableFocus = (active: Element | null, root: Element | null): boolean =>
    active instanceof HTMLElement
    && !root?.contains(active)
    && (active.isContentEditable || active.matches('input, textarea'));
