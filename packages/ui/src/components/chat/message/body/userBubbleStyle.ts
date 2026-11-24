import type React from 'react';

/**
 * The prompt bubble's shape: fill, radii, padding and hairline. It lives here
 * so a card that reads as the user's own row, such as an answered question,
 * draws the same bubble instead of repeating its numbers.
 *
 * The repetition is what drifted. A card that copied the radii and the padding
 * but mixed its own fill stopped reading as a bubble at all: its tint was a
 * small alpha over the page, so it looked like a floating black bar with a
 * strip of bare background above the content.
 *
 * The tail corner is at the end of the block in either direction, so it stays
 * the far corner in a right-to-left layout.
 */
export const userBubbleStyle = (fill: React.CSSProperties['backgroundColor']): React.CSSProperties => ({
    backgroundColor: fill,
    borderRadius: 'var(--radius-xl)',
    borderEndEndRadius: 'var(--radius-sm)',
});

/**
 * The bubble's fill for a card that belongs to the row it sits in but is not a
 * typed prompt, such as a question the app asked. `role` is a solid colour role
 * such as `--status-question`; the result mixes it into the prompt's own fill,
 * so the card follows the theme's bubble colour and reads as its purple
 * sibling.
 *
 * Mix the solid role, not the role's own `-background` tint: that tint is
 * already translucent, and mixing it into the fill carries its alpha through,
 * which is the near-clear card this replaced.
 */
export const userBubbleTintedFill = (role: string, amount = 14): string => (
    `color-mix(in srgb, var(${role}) ${amount}%, var(--chat-user-message-bg))`
);

/** The bubble's padding and hairline, shared so a card lines up with a prompt. */
export const USER_BUBBLE_SHELL_CLASS = 'px-5 py-3 shadow-none border border-primary/5';
