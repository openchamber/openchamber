import { EditorView } from '@codemirror/view';
import { isIMECompositionEvent } from '@/lib/ime';
import { isLinuxPlatform } from '@/lib/platform';
import { getTerminalFocusOwner } from '@/lib/terminalFocus';
import { CHAT_INPUT_EDITOR_SELECTOR, findMainChatInputEditor } from './dom';

// Typing, pasting or coming back to the window with nothing that takes text
// focused lands in a chat composer, so the user can start typing anywhere. A
// middle click stays with its pointer target.

const EDITABLE_SELECTOR = [
    'input', 'textarea', 'select', 'iframe', 'webview',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
].join(',');

// Keys on these keep their own meaning: Space and letters press a button,
// follow a link, or jump through a list.
const INTERACTIVE_SELECTOR = [
    'button', 'a[href]', 'summary',
    '[role="button"]', '[role="checkbox"]', '[role="combobox"]', '[role="link"]',
    '[role="listbox"]', '[role="menuitem"]', '[role="option"]', '[role="radio"]',
    '[role="slider"]', '[role="switch"]', '[role="tab"]',
].join(',');

// While any of these is on screen, typing belongs to it. Lists and popper
// wrappers stay out: the prompt navigator rail is a list that stays on
// screen, and a tooltip under the pointer is a popper.
const FLOATING_LAYER_SELECTOR = [
    '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]',
    '[data-slot="select-content"][data-open]', '[data-settings-view="true"]',
    '[data-btw-composer="true"]',
].join(',');

// Chromium fires the PRIMARY paste right after the button release, and the
// next pointerdown or keydown clears the pending click. This only bounds a
// paste that arrives long after its click.
const MIDDLE_CLICK_PASTE_WINDOW_MS = 1000;

const isElement = (target: EventTarget | null): target is Element => target instanceof Element;

// Window listeners see a shadow root's host as the target; the composed path
// keeps the field the user actually clicked or pasted into.
function eventTarget(event: Event): EventTarget | null {
    return event.composedPath()[0] ?? event.target;
}

function findComposerEditor(target: EventTarget | null): HTMLElement | null {
    if (!isElement(target)) return null;
    return target.closest<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)
        ?? target.closest<HTMLElement>('[data-chat-input="true"]')?.querySelector<HTMLElement>('.cm-content')
        ?? null;
}

const editableRoot = (target: EventTarget | null): Element | null => (
    isElement(target) ? target.closest(EDITABLE_SELECTOR) : null
);

// A terminal canvas and its hidden textarea are one owner; a composer's
// content and its padding are one owner; any other field owns itself.
function pasteOwner(target: EventTarget | null): Element | string | null {
    return getTerminalFocusOwner(target) ?? findComposerEditor(target) ?? editableRoot(target);
}

// The middle-click paste lands at CodeMirror's current caret. Move it to the
// pointer before Chromium starts the paste.
function placeComposerCaret(target: EventTarget | null, event: MouseEvent): void {
    const editor = findComposerEditor(target);
    if (!editor) return;
    const view = EditorView.findFromDOM(editor);
    if (!view || !view.state.facet(EditorView.editable)) return;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return;
    view.focus();
    view.dispatch({ selection: { anchor: position } });
}

function hasFloatingLayer(): boolean {
    for (const layer of document.querySelectorAll(FLOATING_LAYER_SELECTOR)) {
        if (layer.getClientRects().length > 0) return true;
    }
    return false;
}

function hasTextSelection(): boolean {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed);
}

function takesInputItself(element: Element | null): boolean {
    return Boolean(element?.closest(EDITABLE_SELECTOR) || element?.closest(INTERACTIVE_SELECTOR));
}

function isOpenTarget(event: Event): boolean {
    if (event.defaultPrevented) return false;
    const target = eventTarget(event);
    if (isElement(target) && takesInputItself(target)) return false;
    return !hasFloatingLayer();
}

function isOnScreen(editor: HTMLElement | null): editor is HTMLElement {
    return Boolean(editor && editor.getClientRects().length > 0);
}

export type ComposerInputRedirect = {
    /** Remembers the chat column and pointer target. */
    rememberColumn: (event: Event) => void;
    /** Moves a pending middle click's timestamp to its button release. */
    releaseMiddleClick: (event: Event) => void;
    /** Clears pointer state before keyboard paste handling. */
    clearPendingMiddleClick: () => void;
    /** Pairs a Linux middle click with its paste and suppresses page chrome. */
    captureMiddleClickPaste: (event: ClipboardEvent) => void;
    /** Sends a printable key with no text field focused to the composer. */
    redirectKey: (event: KeyboardEvent) => boolean;
    /** Sends a paste with no text field focused to the composer. */
    redirectPaste: (event: ClipboardEvent, allowComposerFallback?: boolean) => boolean;
    /** Puts the caret back in the composer when the window regains focus. */
    refocusAfterWindowFocus: () => void;
};

/**
 * The composer that receives redirected input: a chat pinned in the side
 * panel when the user last clicked or focused into it, the main chat's
 * otherwise.
 */
export function createComposerInputRedirect(): ComposerInputRedirect {
    let lastColumn: Element | null = null;
    let pendingMiddleClick: { target: Element | null; timeStamp: number } | null = null;
    // An allowed middle-click paste still reaches the bubble fallback. Remember
    // it there so the fallback leaves the native paste alone.
    const allowedMiddleClickPastes = new WeakSet<ClipboardEvent>();

    // A native paste carries no button, so pair it with the recent Linux middle
    // click. Return true to suppress a paste aimed at page chrome, false to let
    // the browser paste into the field or terminal that was clicked, and null
    // when this paste is not a middle click.
    const routeMiddleClickPaste = (event: ClipboardEvent): boolean | null => {
        const pending = pendingMiddleClick;
        pendingMiddleClick = null;
        if (!pending) return null;
        const age = event.timeStamp - pending.timeStamp;
        if (age < 0 || age > MIDDLE_CLICK_PASTE_WINDOW_MS) return null;
        const clicked = pasteOwner(pending.target);
        if (clicked !== null && clicked === pasteOwner(eventTarget(event))) return false;

        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
    };

    const targetView = (): EditorView | null => {
        const pinned = lastColumn?.isConnected && lastColumn.getAttribute('data-chat-column') === 'pinned'
            ? lastColumn.querySelector<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR)
            : null;
        const editor = isOnScreen(pinned) ? pinned : findMainChatInputEditor();
        if (!isOnScreen(editor)) return null;
        const view = EditorView.findFromDOM(editor);
        return view && view.state.facet(EditorView.editable) ? view : null;
    };

    const insertAtEnd = (view: EditorView, text: string) => {
        const end = view.state.doc.length;
        view.focus();
        view.dispatch({
            changes: { from: end, insert: text },
            selection: { anchor: end + text.length },
            userEvent: 'input.type',
            scrollIntoView: true,
        });
    };

    return {
        rememberColumn(event) {
            const target = eventTarget(event);
            if (event.type === 'pointerdown') {
                const middleClick = isLinuxPlatform()
                    && event instanceof MouseEvent
                    && event.button === 1;
                if (middleClick) placeComposerCaret(target, event);
                pendingMiddleClick = middleClick
                    ? { target: isElement(target) ? target : null, timeStamp: event.timeStamp }
                    : null;
            }
            const column = isElement(target) ? target.closest('[data-chat-column]') : null;
            if (column) lastColumn = column;
        },

        releaseMiddleClick(event) {
            if (event.type === 'pointercancel') {
                pendingMiddleClick = null;
                return;
            }
            if (!pendingMiddleClick || !(event instanceof MouseEvent) || event.button !== 1) return;
            pendingMiddleClick.timeStamp = event.timeStamp;
        },

        clearPendingMiddleClick() {
            pendingMiddleClick = null;
        },

        captureMiddleClickPaste(event) {
            if (routeMiddleClickPaste(event) === false) {
                allowedMiddleClickPastes.add(event);
            }
        },

        redirectKey(event) {
            if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
            if (isIMECompositionEvent(event) || !isOpenTarget(event)) return false;
            // Typing over selected text starts a comment on it (chat, file
            // preview), so the keys stay with the selection.
            if (hasTextSelection()) return false;
            const view = targetView();
            if (!view) return false;
            event.preventDefault();
            insertAtEnd(view, event.key);
            return true;
        },

        redirectPaste(event, allowComposerFallback = true) {
            if (allowedMiddleClickPastes.delete(event)) return false;
            if (!allowComposerFallback) return false;
            const data = event.clipboardData;
            if (!data || !isOpenTarget(event)) return false;
            const view = targetView();
            if (!view) return false;
            event.preventDefault();
            const end = view.state.doc.length;
            view.focus();
            view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
            // Replayed on the editor, the paste goes through the composer's own
            // handling: attachments, large text, file mentions.
            const replay = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
            view.contentDOM.dispatchEvent(replay);
            const text = data.getData('text/plain');
            if (!replay.defaultPrevented && text) insertAtEnd(view, text);
            return true;
        },

        refocusAfterWindowFocus() {
            pendingMiddleClick = null;
            // Focus on a button or link yields to the composer; focus that
            // takes text (a field, the terminal, an editor, a page) stays.
            const active = document.activeElement;
            if (active?.closest(EDITABLE_SELECTOR) || hasFloatingLayer()) return;
            // A selection in the transcript survives a trip to another app.
            if (hasTextSelection()) return;
            targetView()?.focus();
        },
    };
}
