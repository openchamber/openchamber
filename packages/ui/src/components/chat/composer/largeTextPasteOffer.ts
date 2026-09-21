/**
 * Offer-id state for the large-text paste ask toast.
 *
 * The toast can outlive the paste event (duration Infinity), and a second
 * large paste can supersede an unanswered offer. These helpers keep that
 * invalidation pure so ChatInput only wires toast UI to attach/inline actions.
 */

/** Allocate a new offer id, superseding any unanswered previous offer. */
export const beginLargeTextPasteOffer = (activeOfferId: number): number => (
    activeOfferId + 1
);

/**
 * Attempt to resolve an offer. Returns whether this call won the race, and the
 * next active id. A superseded or already-resolved offer is rejected so
 * dismiss/action cannot double-apply.
 */
export const resolveLargeTextPasteOffer = (
    activeOfferId: number,
    offerId: number,
) => {
    if (offerId !== activeOfferId) {
        return { accepted: false, nextOfferId: activeOfferId };
    }
    return { accepted: true, nextOfferId: activeOfferId + 1 };
};

/** Toast chrome: widen on desktop only; leave mobile full-width to Sonner. */
export const LARGE_TEXT_PASTE_TOAST_CLASSNAME =
    '[&_[data-icon]]:!hidden sm:!min-w-[22rem] sm:!w-auto';
