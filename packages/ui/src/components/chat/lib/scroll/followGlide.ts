// The live follow's motion. Where the browser can take a scroll offset every
// frame, a critically damped spring we draw ourselves, one scrollTop write per
// frame: a new target keeps the current velocity, so a reply landing block
// after block reads as one continuous glide. Chromium's native smooth scroll
// restarts from rest on every scrollTo and stops before the next block lands.
// iOS WebKit moves scrollTop in whole pixels from the main thread, so a
// per-frame offset steps visibly there; it keeps the native smooth scroll.
// See DOCUMENTATION.md, "Why the follow draws its own glide".

// ω² of the spring, in 1/s². Settles a one-screen step in about 600 ms; a
// block of 60 px that lands 400 ms after the last (lib/streamTextCommit.ts)
// finds the glide still moving.
const STIFFNESS = 250;
const OMEGA = Math.sqrt(STIFFNESS);
// Close enough to the target to stop: under half a pixel, barely moving.
const SETTLE_DISTANCE_PX = 0.5;
const SETTLE_VELOCITY_PX_S = 20;
// A frame that arrives late (a long task) advances the spring this far at most.
const MAX_STEP_S = 0.05;
// A scroll offset further than this from our last write was moved by someone
// else.
const FOREIGN_WRITE_PX = 1;
// How long a just-issued native smooth scroll counts as moving before it has
// moved: it starts a frame or two after it is issued.
const NATIVE_START_GRACE_MS = 50;

// What the glide uses of the scroll node.
interface GlideScrollNode {
    scrollTop: number;
    scrollTo(options: { top: number; behavior: 'auto' | 'smooth' }): void;
    addEventListener(type: 'scrollend', listener: () => void): void;
    removeEventListener(type: 'scrollend', listener: () => void): void;
}

interface FollowGlideOptions {
    node: GlideScrollNode;
    /** Checked every frame; false ends the glide where it is. */
    shouldContinue: () => boolean;
    /** The glide reached its target and stopped. */
    onSettle: () => void;
    /** Someone else moved the viewport, and the glide stopped there. */
    onYield?: () => void;
    /** Leave the motion to the browser's smooth scroll (iOS WebKit). */
    native?: boolean;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
    now?: () => number;
}

export interface FollowGlide {
    /**
     * Start toward `target`, or re-aim a glide under way without losing its
     * speed. `stateEnd` is the list's end when aimed, for `isHeadingTo`.
     * `instant` writes the target at once (reduced motion).
     */
    aim: (target: number, stateEnd: number, instant: boolean) => void;
    /**
     * Under way toward the end the list still reports, so it can be left to
     * finish. `stateScroll` is the list's own offset, which costs no layout.
     */
    isHeadingTo: (stateEnd: number, stateScroll: number) => boolean;
    stop: () => void;
    dispose: () => void;
}

// The browser's smooth scroll, re-issued for each new end. It restarts the
// animation, so it is left alone while it still moves toward an unchanged end.
const createNativeFollowGlide = (options: FollowGlideOptions): FollowGlide => {
    const { node, onSettle } = options;
    const now = options.now ?? (() => performance.now());
    let glide: { lastTop: number; issuedAt: number; stateEnd: number } | null = null;
    const landed = () => {
        if (glide) onSettle();
    };
    node.addEventListener('scrollend', landed);
    return {
        aim: (target, stateEnd, instant) => {
            glide = { lastTop: node.scrollTop, issuedAt: now(), stateEnd };
            node.scrollTo({ top: target, behavior: instant ? 'auto' : 'smooth' });
        },
        isHeadingTo: (stateEnd, stateScroll) => {
            if (!glide) return false;
            const moving = Math.abs(stateScroll - glide.lastTop) > 0.5 || now() - glide.issuedAt < NATIVE_START_GRACE_MS;
            glide.lastTop = stateScroll;
            return moving && Math.abs(glide.stateEnd - stateEnd) <= 1;
        },
        stop: () => { glide = null; },
        dispose: () => {
            glide = null;
            node.removeEventListener('scrollend', landed);
        },
    };
};

export const createFollowGlide = (options: FollowGlideOptions): FollowGlide => {
    if (options.native) return createNativeFollowGlide(options);
    const { node, shouldContinue, onSettle, onYield } = options;
    const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
    const now = options.now ?? (() => performance.now());

    let frame: number | null = null;
    let position = 0;
    let velocity = 0;
    let target = 0;
    let written = 0;
    let lastTime = 0;
    let aimedStateEnd = 0;

    const stop = () => {
        if (frame !== null) cancelFrame(frame);
        frame = null;
        velocity = 0;
    };

    const write = (top: number) => {
        node.scrollTop = top;
        // Read back what the browser kept: it rounds to device pixels and
        // clamps to the content.
        written = node.scrollTop;
    };

    const settle = () => {
        stop();
        onSettle();
    };

    const step = (time: number) => {
        frame = null;
        if (!shouldContinue()) {
            stop();
            return;
        }
        // Someone else moved the viewport: the list holding the end it opened
        // at or a row in place, a wheel, a resize. The glide yields, as the
        // browser's own smooth scroll does, and the next growth aims it again.
        // Carrying on fought the list's instant writes every frame, and the
        // chat shook until the reader scrolled.
        if (Math.abs(node.scrollTop - written) > FOREIGN_WRITE_PX) {
            stop();
            onYield?.();
            return;
        }
        const dt = Math.min(MAX_STEP_S, Math.max(0, (time - lastTime) / 1000));
        lastTime = time;
        // Exact step of a critically damped spring: x(t) = (e + c·t)·e^(−ωt).
        const offset = position - target;
        const c = velocity + OMEGA * offset;
        const decay = Math.exp(-OMEGA * dt);
        const nextOffset = (offset + c * dt) * decay;
        velocity = (velocity - OMEGA * c * dt) * decay;
        position = target + nextOffset;
        if (Math.abs(nextOffset) < SETTLE_DISTANCE_PX && Math.abs(velocity) < SETTLE_VELOCITY_PX_S) {
            write(target);
            settle();
            return;
        }
        write(position);
        // Clamped short of where the spring is: the content ends here.
        if (written < position - FOREIGN_WRITE_PX && velocity > 0) {
            settle();
            return;
        }
        frame = requestFrame(step);
    };

    const aim = (nextTarget: number, stateEnd: number, instant: boolean) => {
        target = nextTarget;
        aimedStateEnd = stateEnd;
        const actual = node.scrollTop;
        if (frame === null || Math.abs(actual - written) > FOREIGN_WRITE_PX) position = actual;
        written = actual;
        if (instant) {
            write(target);
            settle();
            return;
        }
        if (frame === null) {
            velocity = 0;
            lastTime = now();
            frame = requestFrame(step);
        }
    };

    const isHeadingTo = (stateEnd: number) => (
        frame !== null && Math.abs(aimedStateEnd - stateEnd) <= 1
    );

    return { aim, isHeadingTo, stop, dispose: stop };
};
