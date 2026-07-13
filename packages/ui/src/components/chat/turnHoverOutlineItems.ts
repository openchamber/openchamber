import { getMessagePreview } from './lib/messagePreview';
import type { ChatMessageEntry } from './lib/turns/types';
import type { TurnWindowModel } from './lib/turns/windowTurns';

export type TurnOutlineItem = {
    turnId: string;
    preview: string;
};

const MAX_RAIL_MARKERS = 20;

export function buildTurnOutlineItems(
    messages: ChatMessageEntry[],
    turnWindowModel: Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>,
    previousItems?: TurnOutlineItem[],
): TurnOutlineItem[] {
    const previousItemsByTurnId = previousItems
        ? new Map(previousItems.map((item) => [item.turnId, item]))
        : undefined;
    let unchanged = previousItems?.length === turnWindowModel.turnIds.length;
    const items = turnWindowModel.turnIds.flatMap((turnId, turnIndex) => {
        const messageIndex = turnWindowModel.turnMessageStartIndexes[turnIndex];
        const message = typeof messageIndex === 'number' ? messages[messageIndex] : undefined;
        if (!message || message.info.id !== turnId) {
            unchanged = false;
            return [];
        }

        const preview = getMessagePreview(message.parts);
        const previousItem = previousItemsByTurnId?.get(turnId);
        if (previousItem?.preview === preview) {
            if (previousItems?.[turnIndex] !== previousItem) unchanged = false;
            return [previousItem];
        }

        unchanged = false;
        return [{ turnId, preview }];
    });

    return unchanged && previousItems ? previousItems : items;
}

export function getRailTurnOutlineItems(
    items: TurnOutlineItem[],
    activeTurnId: string | null,
): TurnOutlineItem[] {
    if (items.length <= MAX_RAIL_MARKERS) return items;

    const activeIndex = activeTurnId ? items.findIndex((item) => item.turnId === activeTurnId) : -1;
    const indexes = Array.from(
        { length: MAX_RAIL_MARKERS },
        (_, markerIndex) => Math.round(markerIndex * (items.length - 1) / (MAX_RAIL_MARKERS - 1)),
    );

    if (activeIndex > 0 && activeIndex < items.length - 1 && !indexes.includes(activeIndex)) {
        let replacementIndex = 1;
        for (let index = 2; index < indexes.length - 1; index += 1) {
            if (Math.abs(indexes[index] - activeIndex) < Math.abs(indexes[replacementIndex] - activeIndex)) {
                replacementIndex = index;
            }
        }
        indexes[replacementIndex] = activeIndex;
    }

    return [...new Set(indexes)].sort((left, right) => left - right).map((index) => items[index]);
}
