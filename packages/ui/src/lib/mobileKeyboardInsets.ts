
const READERS = {
    '--oc-keyboard-inset': '.oc-keyboard-inset-snap, .pwa-overlay-panel, .oc-keyboard-fill-screen, [data-keyboard-inset-reader]',
    '--oc-kb-layout': '.oc-mobile-app-shell, .oc-mobile-app-shell .chat-scroll, .oc-mobile-app-shell .chat-scroll-fade--end, .oc-mobile-app-shell .oc-ipad-sidebar',
    '--oc-kb-surface': '.oc-keyboard-inset-surface',
    '--oc-kb-scroll-inset': '.oc-mobile-app-shell .chat-scroll',
} as const satisfies Record<string, string>;

type MobileKeyboardVar = keyof typeof READERS;

const values = new Map<MobileKeyboardVar, number>();

const applyTo = (element: HTMLElement, name: MobileKeyboardVar): void => {
    const value = values.get(name);
    if (value === undefined) element.style.removeProperty(name);
    else element.style.setProperty(name, `${value}px`);
};

const applyWithin = (root: Element): void => {
    for (const name of Object.keys(READERS) as MobileKeyboardVar[]) {
        if (!values.has(name)) continue;
        if (root instanceof HTMLElement && root.matches(READERS[name])) applyTo(root, name);
        for (const element of root.querySelectorAll<HTMLElement>(READERS[name])) applyTo(element, name);
    }
};

let lateReaders: MutationObserver | null = null;

const watchLateReaders = (): void => {
    const active = Array.from(values.values()).some((value) => value > 0);
    if (!active) {
        lateReaders?.disconnect();
        lateReaders = null;
        return;
    }
    if (lateReaders || typeof MutationObserver === 'undefined') return;
    lateReaders = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) applyWithin(node);
            }
        }
    });
    lateReaders.observe(document.body, { childList: true, subtree: true });
};

export const writeMobileKeyboardVar = (name: MobileKeyboardVar, px: number | null): void => {
    if (px === null) values.delete(name);
    else values.set(name, Math.max(0, Math.round(px)));
    for (const element of document.querySelectorAll<HTMLElement>(READERS[name])) applyTo(element, name);
    watchLateReaders();
};

export const readMobileKeyboardVar = (name: MobileKeyboardVar): number => values.get(name) ?? 0;
