// How the chat follows a live reply, and the rules that decide it.
//
// The viewport trails the growing tail with one native smooth scroll after
// another; the reply lands a block at a time (lib/streamTextCommit.ts), so
// each landing reads as one short glide. Pure: no DOM, no React.

// How long a just-issued follow glide counts as moving before it has moved:
// a smooth scroll starts a frame or two after it is issued.
export const GLIDE_START_GRACE_MS = 50;

interface FollowGlideProgress {
    // Scroll offset when last checked.
    readonly lastTop: number;
    readonly issuedAt: number;
    // The content end per the list's state when the glide was issued.
    readonly stateEnd: number;
}

/**
 * Whether a follow glide is still under way and should be left to finish,
 * decided from the list's state alone so these frames read no layout. A glide
 * is re-issued once the end moved on (re-issuing restarts the animation, so
 * only then).
 */
export const isFollowGlideUnderWay = (
    glide: FollowGlideProgress | null,
    stateScroll: number,
    stateEnd: number,
    now: number,
): boolean => (
    glide !== null
    && (Math.abs(stateScroll - glide.lastTop) > 0.5 || now - glide.issuedAt < GLIDE_START_GRACE_MS)
    && Math.abs(glide.stateEnd - stateEnd) <= 1
);

/**
 * Where a follow glide should go, or null to hold still: the true end (the
 * tail just above the composer, through the tail spacer) unless the viewport
 * is already there.
 */
export const resolveFollowGlideTarget = (end: number, scroll: number): number | null => (
    end - scroll <= 1 ? null : Math.max(0, end)
);

/**
 * Where the follow stops at a turn or reply that outgrew the screen, so it can
 * be read from the top while the rest lands below. `limit` is the scroll
 * offset that puts its start at the top of the viewport, `bottom` the content
 * offset of its end, and `visibleLength` the viewport height the composer
 * leaves readable. The follow goes no further than `limit`, and `hold` says
 * it ends there.
 *
 * Only the turn or reply itself outgrowing that height counts. Growth below
 * it (the turn footer, a banner docked on the composer) also carries the
 * start off the top on the way to the end, and stopping for it left the pill
 * up under a reader who was on the end.
 */
export const resolveFollowStop = (
    target: number,
    stop: { readonly limit: number; readonly bottom: number },
    visibleLength: number,
): { target: number; hold: boolean } => (
    target > stop.limit + 1 && stop.bottom - stop.limit > visibleLength
        ? { target: stop.limit, hold: true }
        : { target, hold: false }
);

/**
 * Where to scroll so a page waiting for the reader's answer is in view, or
 * null when it already is. `page` is its content offsets, `topGap` the room
 * kept under the top edge and `visibleLength` the viewport height the
 * composer leaves readable. A page that fits ends at the visible bottom; one
 * taller than that starts at the top.
 */
export const resolvePageRevealTarget = (
    page: { readonly top: number; readonly bottom: number },
    scroll: number,
    visibleLength: number,
    topGap: number,
): number | null => {
    const fits = page.bottom - page.top <= visibleLength - topGap;
    const target = fits && page.bottom > scroll + visibleLength
        ? page.bottom - visibleLength
        : !fits || page.top < scroll + topGap ? page.top - topGap : null;
    if (target === null) return null;
    const clamped = Math.max(0, target);
    return Math.abs(clamped - scroll) <= 1 ? null : clamped;
};
