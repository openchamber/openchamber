const REPLY_START_GAP_PX = 16;

interface FollowStop {
    readonly element: HTMLElement;
    readonly limit: number;
    readonly bottom: number;
}

export interface StopLanding {
    readonly element: HTMLElement;
    readonly generation: number;
    aimed: number | null;
}

const lastMatch = (node: HTMLElement, selector: string): HTMLElement | null => {
    const matches = node.querySelectorAll<HTMLElement>(selector);
    return matches[matches.length - 1] ?? null;
};

const turnIdOf = (element: HTMLElement): string | undefined => (
    element.closest<HTMLElement>('[data-turn-row]')?.dataset.turnRow
        ?? element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId
);

const readFollowStop = (node: HTMLElement, element: HTMLElement): FollowStop => {
    const rect = element.getBoundingClientRect();
    const offset = node.scrollTop - node.getBoundingClientRect().top;
    const turnId = turnIdOf(element);
    const header = turnId
        ? node.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"] > [data-turn-sticky-header]`)
        : null;
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    return {
        element,
        limit: Math.max(0, rect.top + offset - headerHeight - REPLY_START_GAP_PX),
        bottom: rect.bottom + offset,
    };
};

const findLatestTurnId = (node: HTMLElement): string | undefined => {
    let latest: HTMLElement | null = null;
    let latestTop = Number.NEGATIVE_INFINITY;
    for (const row of node.querySelectorAll<HTMLElement>('[data-turn-id], [data-turn-row]')) {
        const top = row.getBoundingClientRect().top;
        if (top > latestTop) {
            latest = row;
            latestTop = top;
        }
    }
    return latest ? turnIdOf(latest) : undefined;
};

export const findStreamingReply = (node: HTMLElement): HTMLElement | null => lastMatch(node, '[data-streaming-reply]');

export const findFollowStops = (node: HTMLElement, stopAfterUserMessage: boolean, reply: HTMLElement | null): FollowStop[] => {
    const stops: FollowStop[] = [];
    const turnId = stopAfterUserMessage ? findLatestTurnId(node) : undefined;
    let work: HTMLElement | null = null;
    let workBottom = Number.NEGATIVE_INFINITY;
    if (turnId) {
        for (const row of node.querySelectorAll<HTMLElement>(`[data-turn-row="${CSS.escape(turnId)}"]`)) {
            const rect = row.getBoundingClientRect();
            if (!work || rect.top < work.getBoundingClientRect().top) work = row;
            workBottom = Math.max(workBottom, rect.bottom);
        }
    }
    if (work) {
        const stop = readFollowStop(node, work);
        stops.push({ ...stop, bottom: workBottom + node.scrollTop - node.getBoundingClientRect().top });
    }
    if (reply) stops.push(readFollowStop(node, reply));
    return stops;
};

export const resolveStopLandingTarget = (
    node: HTMLElement,
    pending: StopLanding,
    generation: number,
    footerSize: number,
    stopAfterUserMessage: boolean,
): number | null => {
    if (pending.generation !== generation || !pending.element.isConnected) return null;
    const reply = pending.element.matches('[data-turn-row]') ? null : pending.element;
    const stop = findFollowStops(node, stopAfterUserMessage, reply).find((candidate) => candidate.element === pending.element);
    if (!stop) return null;
    const end = Math.max(0, node.scrollHeight - node.clientHeight);
    if (stop.limit >= end) return null;
    if (stop.bottom - stop.limit <= node.clientHeight - footerSize) return null;
    return Math.abs(stop.limit - node.scrollTop) <= 1 ? null : stop.limit;
};
