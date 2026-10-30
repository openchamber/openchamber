/**
 * The iOS keyboard's geometry for the elements that follow it.
 *
 * Written on the document root, these values inherited into every element,
 * and each keyboard open or close restyled the whole page: about 150 ms per
 * write on a long chat (Chrome at 4x CPU throttling), which on the phone held
 * the composer and the transcript still while the keyboard was already
 * rising. So they are registered non-inherited (mobile.css) and written only
 * on the elements that read them, found by selector at each write. While a
 * value is set, a reader that mounts later (a sheet opened over the raised
 * keyboard) gets it as it enters the document.
 */

const READERS = {
    // The keyboard's height from the moment it starts to rise.
    '--oc-keyboard-inset': '.oc-keyboard-inset-snap, .pwa-overlay-panel, .oc-keyboard-fill-screen, [data-keyboard-inset-reader]',
    // The same height applied to the shell's layout where the change is
    // invisible (once the keyboard has landed, as it starts to fall), for a
    // keyboard opened in the shell.
    '--oc-kb-layout': '.oc-mobile-app-shell, .oc-mobile-app-shell .chat-scroll, .oc-mobile-app-shell .chat-scroll-fade--end, .oc-mobile-app-shell .oc-ipad-sidebar',
    // The same, for the surfaces over the shell, whichever field opened it.
    '--oc-kb-surface': '.oc-keyboard-inset-surface',
    // The strip the chat scroller reserves for the keyboard from the start of the rise.
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

// Watches for readers only while some value is set (the keyboard is up or
// the layout still holds it).
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

/** Writes the value on every element that reads it; null clears it. */
export const writeMobileKeyboardVar = (name: MobileKeyboardVar, px: number | null): void => {
    if (px === null) values.delete(name);
    else values.set(name, Math.max(0, Math.round(px)));
    for (const element of document.querySelectorAll<HTMLElement>(READERS[name])) applyTo(element, name);
    watchLateReaders();
};

/** The value last written, in px (0 while the keyboard is down). */
export const readMobileKeyboardVar = (name: MobileKeyboardVar): number => values.get(name) ?? 0;
