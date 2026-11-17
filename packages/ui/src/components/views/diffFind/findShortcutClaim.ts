export const isForeignEditableFocus = (active: Element | null, root: Element | null): boolean =>
    active instanceof HTMLElement
    && !root?.contains(active)
    && (active.isContentEditable || active.matches('input, textarea'));
