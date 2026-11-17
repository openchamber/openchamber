
export const beginLargeTextPasteOffer = (activeOfferId: number): number => (
    activeOfferId + 1
);

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
        restoreFocus: choice.explicitlyChosen,
    };
};
