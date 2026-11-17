import { EditorView } from '@codemirror/view';
import { isIMECompositionEvent } from '@/lib/ime';
import { isLinuxPlatform } from '@/lib/platform';
import { getTerminalFocusOwner } from '@/lib/terminalFocus';
import { CHAT_INPUT_EDITOR_SELECTOR, findMainChatInputEditor } from './dom';


const EDITABLE_SELECTOR = [
    'input', 'textarea', 'select', 'iframe', 'webview',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
].join(',');

const INTERACTIVE_SELECTOR = [
    'button', 'a[href]', 'summary',
    '[role="button"]', '[role="checkbox"]', '[role="combobox"]', '[role="link"]',
    '[role="listbox"]', '[role="menuitem"]', '[role="option"]', '[role="radio"]',
    '[role="slider"]', '[role="switch"]', '[role="tab"]',
].join(',');

const FLOATING_LAYER_SELECTOR = [
    '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]',
    '[data-slot="select-content"][data-open]', '[data-settings-view="true"]',
    '[data-btw-composer="true"]',
].join(',');

const MIDDLE_CLICK_PASTE_WINDOW_MS = 1000;

const isElement = (target: EventTarget | null): target is Element => target instanceof Element;

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

function pasteOwner(target: EventTarget | null): Element | string | null {
    return getTerminalFocusOwner(target) ?? findComposerEditor(target) ?? editableRoot(target);
}

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
    rememberColumn: (event: Event) => void;
    releaseMiddleClick: (event: Event) => void;
    clearPendingMiddleClick: () => void;
    captureMiddleClickPaste: (event: ClipboardEvent) => void;
    redirectKey: (event: KeyboardEvent) => boolean;
    redirectPaste: (event: ClipboardEvent, allowComposerFallback?: boolean) => boolean;
    refocusAfterWindowFocus: () => void;
};

export function createComposerInputRedirect(): ComposerInputRedirect {
    let lastColumn: Element | null = null;
    let pendingMiddleClick: { target: Element | null; timeStamp: number } | null = null;
    const allowedMiddleClickPastes = new WeakSet<ClipboardEvent>();

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
            const replay = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
            view.contentDOM.dispatchEvent(replay);
            const text = data.getData('text/plain');
            if (!replay.defaultPrevented && text) insertAtEnd(view, text);
            return true;
        },

        refocusAfterWindowFocus() {
            pendingMiddleClick = null;
            const active = document.activeElement;
            if (active?.closest(EDITABLE_SELECTOR) || hasFloatingLayer()) return;
            if (hasTextSelection()) return;
            targetView()?.focus();
        },
    };
}
