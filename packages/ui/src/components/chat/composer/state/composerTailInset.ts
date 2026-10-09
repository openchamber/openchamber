/**
 * How much of the transcript's end the floating composer reserves.
 *
 * The tail spacer keeps the resting composer (the smallest height its slot
 * has measured) plus a gap. A composer that grows (a top row, more lines of
 * text, the mobile pill expanding) takes the gap first and pushes the
 * transcript only past the growth allowance. ChatContainer publishes the
 * result; the mobile composer morph uses the same rule to announce how far
 * the transcript's end really moves when it swaps pill and full composer.
 */

/**
 * Gap between the last transcript row and the resting composer's top edge,
 * on top of the status row reserve. Generous on purpose: the recap note and
 * the rows docked above the composer (context chips, linked references, the
 * queue) land in this band, and a follow glide that trails the live edge
 * should still leave the last line clear of the glass.
 */
const FLOATING_COMPOSER_GAP_PX = 80;
/**
 * How far the composer grows above its resting height before it pushes the
 * transcript. The visible band at rest is the gap plus the last turn's own
 * bottom padding (about 104px); this leaves about 16px of it above the glass.
 * The recap hint hides while the composer is grown, so nothing else needs
 * the band.
 */
const FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX = 88;
/** Footer reserve before the floating composer slot has been measured. */
const FLOATING_COMPOSER_DEFAULT_HEIGHT = 128;
export const FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX = FLOATING_COMPOSER_DEFAULT_HEIGHT + FLOATING_COMPOSER_GAP_PX;

/** Resting slot height per chat column, while its floating composer is measured. */
const restingHeights = new WeakMap<HTMLElement, number>();

export const resolveComposerTailInset = (restingHeight: number, height: number): number => Math.max(
    restingHeight + FLOATING_COMPOSER_GAP_PX,
    height + FLOATING_COMPOSER_GAP_PX - FLOATING_COMPOSER_GROWTH_ALLOWANCE_PX,
);

/**
 * Records a measured slot height for the column and returns the tail inset
 * and whether the composer is taller than at rest. A zero height (a slot not
 * laid out yet) is not a resting composer.
 */
export const recordComposerSlotHeight = (column: HTMLElement, height: number) => {
    const previous = restingHeights.get(column);
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

/** The tail inset the column will publish once its slot measures `height`. */
export const composerTailInsetFor = (column: HTMLElement, height: number): number => {
    const resting = restingHeights.get(column);
    return resolveComposerTailInset(resting === undefined ? height : Math.min(resting, height), height);
};
