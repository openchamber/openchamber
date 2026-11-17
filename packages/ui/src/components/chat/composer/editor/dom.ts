export const CHAT_INPUT_EDITOR_SELECTOR = '[data-chat-input="true"] .cm-content';

export function findMainChatInputEditor(): HTMLElement | null {
    const editors = document.querySelectorAll<HTMLElement>(CHAT_INPUT_EDITOR_SELECTOR);
    for (const editor of editors) {
        if (!editor.closest('[data-chat-column="pinned"]')) return editor;
    }
    return null;
}

export function focusChatInput(): void {
    findMainChatInputEditor()?.focus();
}
