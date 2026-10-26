import { EditorView } from '@codemirror/view';
import { isIMECompositionEvent } from '@/lib/ime';
import { CHAT_INPUT_EDITOR_SELECTOR, findMainChatInputEditor } from './dom';

// Typing, pasting or coming back to the window with nothing that takes text
// focused lands in a chat composer, so the user can start typing anywhere.

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

const isElement = (target: EventTarget | null): target is Element => target instanceof Element;

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
    if (isElement(event.target) && takesInputItself(event.target)) return false;
    return !hasFloatingLayer();
}

function isOnScreen(editor: HTMLElement | null): editor is HTMLElement {
    return Boolean(editor && editor.getClientRects().length > 0);
}

export type ComposerInputRedirect = {
    /** Remembers the chat the user last clicked or focused into. */
    rememberColumn: (event: Event) => void;
    /** Sends a printable key with no text field focused to the composer. */
    redirectKey: (event: KeyboardEvent) => boolean;
    /** Sends a paste with no text field focused to the composer. */
    redirectPaste: (event: ClipboardEvent) => boolean;
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
            const column = isElement(event.target) ? event.target.closest('[data-chat-column]') : null;
            if (column) lastColumn = column;
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

        redirectPaste(event) {
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
