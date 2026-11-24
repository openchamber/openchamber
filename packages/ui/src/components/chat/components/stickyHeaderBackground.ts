import type React from 'react';

/**
 * The sticky user header paints the chat background so assistant content scrolling
 * underneath disappears behind it. The soft edge lives in the header's own background
 * instead of an overlay below it: the bottom strip of the header box fades the
 * background out, and that strip sits over the empty space the user row already
 * reserves below the bubble. At rest the strip reveals the identical page background
 * (`--background` is generated from the same `surface.background` token), so it is
 * invisible and can never wash over the assistant content that follows.
 *
 * The strip's height follows the reserve: on desktop the user row keeps a 44px gap
 * to the reply (the hover action row plus `ChatMessage`'s sticky padding), so the
 * strip is 2.25rem and the solid background still ends 8px under the bubble; on
 * mobile the header ends with the always-visible actions row instead, and the
 * 0.75rem strip stays clear of it.
 */
const background = (fadeRem: string): React.CSSProperties => ({
    backgroundImage:
        `linear-gradient(to bottom, var(--surface-background) calc(100% - ${fadeRem}), transparent)`,
});
const DESKTOP = background('2.25rem');
const MOBILE = background('0.75rem');

export const stickyHeaderBackground = (isMobile: boolean): React.CSSProperties => (isMobile ? MOBILE : DESKTOP);
