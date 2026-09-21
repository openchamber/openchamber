/**
 * Keeps a pinned transcript on its end THROUGH the mobile keyboard and
 * composer transitions with one continuous scroll motion.
 *
 * The transcript's geometry (the composer's tail spacer, the scroller's
 * keyboard padding) changes in single steps: the composer swaps size in one
 * commit, the keyboard strip is reserved in one write. Left to the pinned-end
 * observer, each step is an instant scrollTop snap — the staircase. Here the
 * observer is held while a transition runs, the geometry is allowed to land
 * in its final state at once, and scrollTop itself is driven frame by frame
 * from where it was to where the end now is, on the keyboard's curve. The
 * composer slides and unfolds on the same curve, so all three move as one.
 *
 * Show: geometry grows first (spacer at the swap, padding at willShow), the
 * viewport glides up to the new end. Hide: geometry is kept until the
 * keyboard has landed, the viewport glides down to where the end WILL be
 * (current end minus the keyboard strip minus the composer's shrink), and
 * the settle snap then only clamps scrollTop to the value it already has.
 *
 * Event contract:
 *  - `oc:composer-morph` (mobileComposerMorph): `hold` at the swap with the
 *    box's height delta; `glide` when the morph runs without a keyboard;
 *    `release` when such a morph ends.
 *  - `oc:keyboard-anim` / `oc:keyboard-settled` (useNativeMobileChrome):
 *    start the glide for a keyboard leg and release the hold when it lands.
 */

import { keyboardEase } from '@/lib/mobileKeyboardTiming';

export interface ComposerMorphEventDetail {
    phase: 'hold' | 'glide' | 'release';
    direction: 'expand' | 'collapse';
    /** Height the box gains (expand) or loses (collapse), in px. */
    delta: number;
    durationMs: number;
}

interface KeyboardAnimEventDetail {
    phase: 'show' | 'hide';
    slide: number;
    durationMs: number;
}

interface KeyboardSettledEventDetail {
    open: boolean;
}

export interface KeyboardFollowGlideOptions {
    scrollNode: HTMLElement;
    /** The reader is pinned to the end and nothing else owns the scroll. */
    canFollow: () => boolean;
}

export interface KeyboardFollowGlide {
    /** A transition is in flight: end pinning must yield to the glide. */
    isHeld: () => boolean;
    dispose: () => void;
}

export function createKeyboardFollowGlide(options: KeyboardFollowGlideOptions): KeyboardFollowGlide {
    const { scrollNode, canFollow } = options;
    let held = false;
    let pendingDelta = 0;
    let frame: number | null = null;
    let lastDirection: 'show' | 'hide' | null = null;

    const endOffset = () => scrollNode.scrollHeight - scrollNode.clientHeight;
    const cancelFrame = () => {
        if (frame !== null) {
            window.cancelAnimationFrame(frame);
            frame = null;
        }
    };

    // A hold announces (or, while held, corrects) the composer's height
    // delta for the leg in flight.
    const hold = (delta: number) => {
        if (!held && !canFollow()) return;
        held = true;
        pendingDelta = delta;
    };

    const glide = (direction: 'show' | 'hide', slide: number, durationMs: number) => {
        if (!held) {
            if (!canFollow()) return;
            held = true;
        }
        cancelFrame();
        lastDirection = direction;
        const from = scrollNode.scrollTop;
        // Show: the end is already final (or becomes final within the frame),
        // so it is read live. Hide: the end shrinks only at settle, so the
        // destination is what will be taken away — resolved on the first
        // frame, after the composer morph (which listens after this hook)
        // has announced its final delta for this leg.
        let hideTarget: number | null = null;
        const startedAt = performance.now();
        const step = (now: number) => {
            if (direction === 'hide' && hideTarget === null) {
                hideTarget = Math.max(0, endOffset() - slide - pendingDelta);
                pendingDelta = 0;
            }
            const progress = durationMs > 0 ? Math.min(1, (now - startedAt) / durationMs) : 1;
            const eased = keyboardEase(progress);
            const target = direction === 'show' ? endOffset() : (hideTarget ?? from);
            scrollNode.scrollTop = from + (target - from) * eased;
            frame = progress < 1 ? window.requestAnimationFrame(step) : null;
        };
        frame = window.requestAnimationFrame(step);
    };

    const release = () => {
        if (!held) return;
        cancelFrame();
        held = false;
        pendingDelta = 0;
        if (lastDirection === 'show') {
            // Land exactly on the end; the hide leg is clamped by the
            // geometry snap instead, so it needs no write.
            const end = endOffset();
            if (Math.abs(end - scrollNode.scrollTop) > 1) scrollNode.scrollTop = end;
        }
        lastDirection = null;
    };

    const handleMorph = (event: Event) => {
        // SAFETY: oc:composer-morph is dispatched only by mobileComposerMorph
        // as a CustomEvent carrying ComposerMorphEventDetail.
        const detail = (event as CustomEvent<ComposerMorphEventDetail>).detail;
        if (detail.phase === 'hold') {
            hold(detail.delta);
            return;
        }
        if (detail.phase === 'glide') {
            glide(detail.direction === 'expand' ? 'show' : 'hide', 0, detail.durationMs);
            return;
        }
        release();
    };
    const handleKeyboardAnim = (event: Event) => {
        // SAFETY: oc:keyboard-anim is dispatched only by useNativeMobileChrome
        // as a CustomEvent carrying phase, slide and durationMs.
        const detail = (event as CustomEvent<KeyboardAnimEventDetail>).detail;
        glide(detail.phase, detail.slide, detail.durationMs);
    };
    const handleKeyboardSettled = (event: Event) => {
        // SAFETY: oc:keyboard-settled is dispatched only by useNativeMobileChrome
        // as a CustomEvent carrying `open`.
        const detail = (event as CustomEvent<KeyboardSettledEventDetail>).detail;
        if (lastDirection === null) return;
        if ((lastDirection === 'show') !== detail.open) return;
        release();
    };

    window.addEventListener('oc:composer-morph', handleMorph);
    window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
    window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);

    return {
        isHeld: () => held,
        dispose: () => {
            cancelFrame();
            held = false;
            window.removeEventListener('oc:composer-morph', handleMorph);
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
        },
    };
}
