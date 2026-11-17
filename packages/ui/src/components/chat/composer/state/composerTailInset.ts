
export const FLOATING_COMPOSER_GAP_PX = 80;
const FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX = 88;
const FLOATING_COMPOSER_DEFAULT_HEIGHT = 128;
export const FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX = FLOATING_COMPOSER_DEFAULT_HEIGHT + FLOATING_COMPOSER_GAP_PX;

const restingHeights = new WeakMap<HTMLElement, number>();

export const resolveComposerTailInset = (restingHeight: number, height: number): number => Math.max(
    restingHeight + FLOATING_COMPOSER_GAP_PX,
    height + FLOATING_COMPOSER_GAP_PX - FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX,
);

export const recordComposerSlotHeight = (column: HTMLElement, height: number, composer = true) => {
    const previous = restingHeights.get(column);
    if (!composer) {
        if (previous === undefined) return { tailInset: FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX, grown: false };
        return { tailInset: resolveComposerTailInset(previous, height), grown: height > previous };
    }
    const resting = height > 0 ? Math.min(previous ?? height, height) : previous;
    if (resting === undefined) {
        return { tailInset: FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX, grown: false };
    }
    restingHeights.set(column, resting);
    return { tailInset: resolveComposerTailInset(resting, height), grown: height > resting };
};

export const forgetComposerSlot = (column: HTMLElement): void => {
    restingHeights.delete(column);
};

export const composerTailInsetFor = (column: HTMLElement, height: number): number => {
    const resting = restingHeights.get(column);
    return resolveComposerTailInset(resting === undefined ? height : Math.min(resting, height), height);
};
