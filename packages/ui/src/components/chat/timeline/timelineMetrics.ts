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

export const isTouchLayout = (): boolean => {
    const root = document.documentElement;
    return root.classList.contains('mobile-pointer') && !root.classList.contains('desktop-runtime');
};

export const readToolLineHeight = (): number => (isTouchLayout() ? 36 : 32);
