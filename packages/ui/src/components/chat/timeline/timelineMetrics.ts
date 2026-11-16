// Where message text wraps: the chat column's content box. Read from a
// column in the list when there is one, else from the column's own rule
// (`.chat-message-column` in typography.css: 48rem, 64rem at the wider chat
// width, the whole chat at full, about 1 to 1.5rem of padding on each side).
export const readColumnWidth = (scroller: HTMLElement | null): number => {
    const column = scroller?.querySelector<HTMLElement>('.chat-message-column');
    if (column && column.clientWidth > 0) {
        const style = getComputedStyle(column);
        return column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }
    const width = scroller?.clientWidth || window.innerWidth;
    const chatWidth = scroller?.closest('[data-chat-width]')?.getAttribute('data-chat-width');
    const cap = chatWidth === 'full' ? width : chatWidth === 'wider' ? 1024 : 768;
    return Math.min(width, cap) - (width >= 1024 ? 48 : 32);
};

// A touch device: raised tap targets (mobile.css) and native scroll momentum.
export const isTouchLayout = (): boolean => {
    const root = document.documentElement;
    return root.classList.contains('mobile-pointer') && !root.classList.contains('desktop-runtime');
};

// A tool, reasoning or file line: 36 px where touch targets are raised, 32 px elsewhere.
export const readToolLineHeight = (): number => (isTouchLayout() ? 36 : 32);
