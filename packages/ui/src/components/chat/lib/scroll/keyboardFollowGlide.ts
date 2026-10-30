/**
 * Keeps a pinned transcript on its end THROUGH the mobile keyboard and
 * composer transitions with one continuous scroll motion.
 *
 * The transcript's geometry (the composer's tail spacer, the scroller's
 * keyboard padding) changes in single steps: the composer swaps size in one
 * commit, the keyboard strip is reserved in one write. Left to the pinned-end
 * observer, each step is an instant scrollTop snap — the staircase. Here the
 * observer is held while a transition runs, the geometry is allowed to land
 * in its final state at once, and the transcript travels from where it was
 * to where the end now is on the keyboard's curve, as a compositor transform
 * on the list's content (see `motion` below). The composer slides and
 * unfolds on the same curve, so all three move as one.
 *
 * Show: geometry grows first (spacer at the swap, padding at willShow), the
 * viewport glides up to the new end. Hide: geometry is kept until the
 * keyboard has landed, the viewport glides down to where the end WILL be
 * (current end minus the keyboard strip minus the composer's shrink), and
 * the settle snap then only clamps scrollTop to the value it already has.
 *
 * Event contract:
 *  - `oc:composer-morph` (mobileComposerMorph): `hold` at the swap with the
 *    tail inset's delta; `glide` when the morph runs without a keyboard;
 *    `release` when such a morph ends.
 *  - `oc:keyboard-anim` / `oc:keyboard-settled` (useNativeMobileChrome):
 *    start the glide for a keyboard leg and release the hold when it lands.
 */

import { keyboardEase, keyboardKeyframes } from '@/lib/mobileKeyboardTiming';

export interface ComposerMorphEventDetail {
    phase: 'hold' | 'glide' | 'release';
    direction: 'expand' | 'collapse';
    /** How far the transcript's end moves: the change of the composer's tail inset, in px. */
    delta: number;
    durationMs: number;
}

interface KeyboardAnimEventDetail {
    phase: 'show' | 'hide';
    slide: number;
    durationMs: number;
    /** False when the field the keyboard is for is on a surface over the shell. */
    inShell?: boolean;
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
    // A keyboard leg is in flight: only its settled event ends the hold.
    let keyboardLeg = false;

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

    // The motion itself. scrollTop moves in whole CSS pixels and, written
    // from a frame loop, at most 60 times a second; on a 120 Hz screen the
    // transcript then crept the last pixels in visible steps beside a
    // composer the compositor moves smoothly. So scrollTop changes once, and
    // the visible travel is a transform the compositor runs on the list's
    // content, always upward (a negative offset adds no scrollable overflow):
    // moving up, scrollTop stays and the content rises, then scrollTop takes
    // the destination as the offset is dropped in the same frame; moving
    // down, scrollTop takes the destination at once and the content, lifted
    // to where it was, settles down into place. A rising motion follows the
    // end while it moves: a reply that grows during the rise retargets it
    // instead of leaving a jump for the landing.
    let motion: {
        animations: Animation[];
        content: HTMLElement;
        headers: HTMLElement[];
        finalTop: number | null;
        endsAt: number;
        observer: ResizeObserver | null;
    } | null = null;

    // The list's content: rows, header and the tail spacer (LegendList finds
    // it the same way).
    const contentNode = (): HTMLElement | null => scrollNode.querySelector<HTMLElement>(':scope > .legend-list-content-container');

    const currentOffset = (element: HTMLElement): number => {
        const transform = getComputedStyle(element).transform;
        if (!transform || transform === 'none') return 0;
        return new DOMMatrixReadOnly(transform).m42;
    };

    // Ends the motion where it stands: the content's visible offset becomes
    // scrollTop again, with the transform dropped in the same frame.
    const settleMotion = (landOnFinal: boolean) => {
        if (!motion) return;
        const { animations, content, finalTop, observer } = motion;
        motion = null;
        observer?.disconnect();
        const top = landOnFinal && finalTop !== null
            ? finalTop
            : scrollNode.scrollTop - currentOffset(content);
        for (const animation of animations) animation.cancel();
        if (Math.abs(top - scrollNode.scrollTop) >= 0.5) scrollNode.scrollTop = top;
    };

    // A user header stuck to the top edge rides the content's offset unless
    // it gets the opposite one: it must stay where it is. Read before the
    // content moves, with scrollTop already where the motion keeps it.
    const stuckHeaders = (content: HTMLElement): HTMLElement[] => {
        const top = scrollNode.getBoundingClientRect().top;
        return Array.from(content.querySelectorAll<HTMLElement>('[data-turn-sticky-header]')).filter((header) => {
            const turn = header.parentElement?.getBoundingClientRect();
            return Boolean(turn) && Math.abs(header.getBoundingClientRect().top - top) < 1 && turn!.bottom > top;
        });
    };

    // Whether a sticky user header would hand over to another one on the way:
    // the top edge of the view passes the start of a turn, or the point where
    // its header stops sticking. One offset cannot show that handover, so such
    // a leg moves scrollTop itself and lets the headers stick natively.
    // `travel` is how far the content moves up (negative: down).
    const crossesStickyEdge = (content: HTMLElement, travel: number): boolean => {
        const top = scrollNode.getBoundingClientRect().top;
        const low = Math.min(0, travel);
        const high = Math.max(0, travel);
        return Array.from(content.querySelectorAll<HTMLElement>('[data-turn-sticky-header]')).some((header) => {
            const turn = header.parentElement?.getBoundingClientRect();
            if (!turn) return false;
            const edges = [turn.top - top, turn.bottom - header.offsetHeight - top];
            return edges.some((edge) => edge > low && edge <= high);
        });
    };

    // The per-frame leg: scrollTop on the keyboard curve. `target` is read
    // every frame, so a rising leg follows an end that grows meanwhile.
    const glideScrollTop = (from: number, target: () => number, durationMs: number, startedAt: number) => {
        const step = (now: number) => {
            const progress = durationMs > 0 ? Math.min(1, (now - startedAt) / durationMs) : 1;
            scrollNode.scrollTop = from + (target() - from) * keyboardEase(progress);
            frame = progress < 1 ? window.requestAnimationFrame(step) : null;
        };
        frame = window.requestAnimationFrame(step);
    };

    // Animates the content's offset (and the stuck headers' opposite one)
    // from one value to another on the keyboard curve.
    const animateOffset = (content: HTMLElement, headers: HTMLElement[], from: number, to: number, durationMs: number): Animation[] => {
        const options: KeyframeAnimationOptions = { duration: durationMs, easing: 'linear', fill: 'forwards' };
        const at = (position: number) => from + (to - from) * position;
        return [
            content.animate(keyboardKeyframes((position) => ({ transform: `translateY(${at(position)}px)` })), options),
            ...headers.map((header) => header.animate(keyboardKeyframes((position) => ({ transform: `translateY(${-at(position)}px)` })), options)),
        ];
    };

    const finishWith = (animations: Animation[]) => {
        animations[0]?.addEventListener('finish', () => {
            if (motion?.animations === animations) settleMotion(true);
        });
    };

    // The end moved while rising (a reply growing, a row measuring): head for
    // the new end from where the content is now, in the time that is left.
    // The upward offset leaves the scrollable height as it is (measured on
    // iOS WebKit, where this runs), so the end reads true mid-motion.
    const retarget = () => {
        if (!motion || motion.finalTop === null) return;
        const offset = currentOffset(motion.content);
        const target = endOffset();
        if (Math.abs(target - motion.finalTop) < 1) return;
        const remaining = Math.max(16, motion.endsAt - performance.now());
        const visualTop = scrollNode.scrollTop - offset;
        if (crossesStickyEdge(motion.content, target - visualTop)) {
            // The longer way now hands a sticky header over: continue from
            // where the content shows, moving scrollTop itself.
            settleMotion(false);
            glideScrollTop(visualTop, endOffset, remaining, performance.now());
            return;
        }
        for (const animation of motion.animations) animation.cancel();
        motion.animations = animateOffset(motion.content, motion.headers, offset, scrollNode.scrollTop - target, remaining);
        motion.finalTop = target;
        finishWith(motion.animations);
    };

    const glide = (direction: 'show' | 'hide', slide: number, durationMs: number) => {
        if (!held) {
            if (!canFollow()) return;
            held = true;
        }
        cancelFrame();
        settleMotion(false);
        lastDirection = direction;
        const startedAt = performance.now();
        // The destination is read on the next frame: by then the geometry of
        // this leg has landed (the keyboard strip, the composer slot the morph
        // pins in the same event, the tail spacer its observer resizes). Show
        // reads the end; hide subtracts what settle will take away.
        frame = window.requestAnimationFrame((now) => {
            frame = null;
            const content = contentNode();
            const from = scrollNode.scrollTop;
            const target = direction === 'show'
                ? endOffset()
                : Math.max(0, endOffset() - slide - pendingDelta);
            if (direction === 'hide') pendingDelta = 0;
            const travel = target - from;
            if (!content || Math.abs(travel) < 0.5) {
                if (Math.abs(travel) >= 0.5) scrollNode.scrollTop = target;
                return;
            }
            if (crossesStickyEdge(content, travel)) {
                glideScrollTop(from, direction === 'show' ? endOffset : () => target, durationMs, startedAt);
                return;
            }
            const rising = travel > 0;
            if (!rising) scrollNode.scrollTop = target;
            const headers = stuckHeaders(content);
            const animations = rising
                ? animateOffset(content, headers, 0, -travel, durationMs)
                : animateOffset(content, headers, travel, 0, durationMs);
            // Started a frame after the keyboard: catch up on the same curve.
            const elapsed = Math.min(Math.max(0, now - startedAt), durationMs);
            for (const animation of animations) animation.currentTime = elapsed;
            const observer = rising && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(retarget) : null;
            motion = { animations, content, headers, finalTop: rising ? target : null, endsAt: now - elapsed + durationMs, observer };
            observer?.observe(content);
            finishWith(animations);
        });
    };

    const release = () => {
        if (!held) return;
        cancelFrame();
        settleMotion(true);
        held = false;
        keyboardLeg = false;
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
        // A morph that ran alone and ended while the keyboard took over must
        // not stop the keyboard's glide halfway: that snapped the transcript
        // to the end in one frame.
        if (keyboardLeg) return;
        release();
    };
    const handleKeyboardAnim = (event: Event) => {
        // SAFETY: oc:keyboard-anim is dispatched only by useNativeMobileChrome
        // as a CustomEvent carrying phase, slide and durationMs.
        const detail = (event as CustomEvent<KeyboardAnimEventDetail>).detail;
        // A keyboard for a field over the chat (a drawer's, a dialog's)
        // leaves the transcript where it is: it is covered.
        if (detail.inShell === false) return;
        glide(detail.phase, detail.slide, detail.durationMs);
        if (held) keyboardLeg = true;
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
            settleMotion(false);
            held = false;
            window.removeEventListener('oc:composer-morph', handleMorph);
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
        },
    };
}
