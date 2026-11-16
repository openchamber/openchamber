export const CHAT_SCROLL_STYLE = {
    // A chat column squeezed to 0px gives the rows no area, and the browser
    // drops the scroll position with the scrollable height.
    minWidth: 1,
    overflowAnchor: 'none',
    overscrollBehavior: 'contain',
    overscrollBehaviorY: 'contain',
} as const;
