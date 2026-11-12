type ScrollContentContainer = {
    readonly isConnected: boolean;
    replaceChildren(): void;
};

/** Release a retired timeline after React finishes detaching its tree. */
export const retireScrollContent = (
    node: ScrollContentContainer,
    isCurrent: () => boolean,
): void => {
    // Chromium can retain a scroll event's target until the next rendered frame.
    // In a suspended webview that target otherwise keeps the entire old timeline
    // alive. Wait for commit/Markdown cache capture, but never wait for a frame.
    queueMicrotask(() => {
        // Ref reattachment and Strict Mode can reuse a node during the commit.
        if (isCurrent() || node.isConnected) return;
        node.replaceChildren();
    });
};
