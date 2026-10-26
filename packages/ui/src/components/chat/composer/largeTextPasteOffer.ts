/**
 * Offer-id state for the large-text paste choice above the composer.
 *
 * The choice outlives the paste event, and a second large paste can supersede
 * an unanswered offer. These helpers keep that invalidation pure so ChatInput
 * only wires the choice UI to attach/inline actions.
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
    choice: { explicitlyChosen: boolean },
) => {
    if (offerId !== activeOfferId) {
        return { accepted: false, nextOfferId: activeOfferId, restoreFocus: false };
    }
    return {
        accepted: true,
        nextOfferId: activeOfferId + 1,
        // An answer returns to the composer; focus that left for elsewhere stays there.
        restoreFocus: choice.explicitlyChosen,
    };
};
