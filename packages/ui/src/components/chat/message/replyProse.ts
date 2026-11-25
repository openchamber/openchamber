const REPLY_PROSE_SELECTOR = '[data-message-text-export-source]';
const REASONING_SELECTOR = '[data-reasoning-block-id], [data-reasoning-inline]';

export function findReplyProseElement(messageElement: HTMLElement): HTMLElement | null {
    for (const element of messageElement.querySelectorAll<HTMLElement>(REPLY_PROSE_SELECTOR)) {
        if (element.closest(REASONING_SELECTOR)) {
            continue;
        }
        return element;
    }
    return null;
}
