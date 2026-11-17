type ScrollContentContainer = {
    readonly isConnected: boolean;
    replaceChildren(): void;
};

export const retireScrollContent = (
    node: ScrollContentContainer,
    isCurrent: () => boolean,
): void => {
    queueMicrotask(() => {
        if (isCurrent() || node.isConnected) return;
        node.replaceChildren();
    });
};
