import { MESSAGE_JUMP_GAP_PX, REPLY_START_GAP_PX } from './scrollGaps';

export const readStuckHeaderHeight = (container: HTMLElement): number => {
    const containerTop = container.getBoundingClientRect().top;
    let height = 0;
    for (const header of container.querySelectorAll<HTMLElement>('[data-turn-sticky-header]')) {
        const rect = header.getBoundingClientRect();
        if (rect.top <= containerTop + 1 && rect.bottom > containerTop) {
            height = Math.max(height, rect.height);
        }
    }
    return height;
};

export const replyTopInset = (container: HTMLElement, element: HTMLElement): number => {
    const turnId = element.closest<HTMLElement>('[data-turn-row]')?.dataset.turnRow
        ?? element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
    if (turnId) {
        const header = container.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"] > [data-turn-sticky-header]`);
        const headerHeight = header?.getBoundingClientRect().height ?? 0;
        if (headerHeight > 0) {
            return headerHeight + REPLY_START_GAP_PX;
        }
    }
    const stuckHeaderHeight = readStuckHeaderHeight(container);
    return stuckHeaderHeight > 0 ? stuckHeaderHeight + REPLY_START_GAP_PX : MESSAGE_JUMP_GAP_PX;
};
