
const STIFFNESS = 250;
const OMEGA = Math.sqrt(STIFFNESS);
const SETTLE_DISTANCE_PX = 0.5;
const SETTLE_VELOCITY_PX_S = 20;
const MAX_STEP_S = 0.05;
const FOREIGN_WRITE_PX = 1;
const NATIVE_START_GRACE_MS = 50;

interface GlideScrollNode {
    scrollTop: number;
    scrollTo(options: { top: number; behavior: 'auto' | 'smooth' }): void;
    addEventListener(type: 'scrollend', listener: () => void): void;
    removeEventListener(type: 'scrollend', listener: () => void): void;
}

interface FollowGlideOptions {
    node: GlideScrollNode;
    shouldContinue: () => boolean;
    onSettle: () => void;
    onYield?: () => void;
    native?: boolean;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
    now?: () => number;
}

export interface FollowGlide {
    aim: (target: number, stateEnd: number, instant: boolean) => void;
    isHeadingTo: (stateEnd: number, stateScroll: number) => boolean;
    stop: () => void;
    dispose: () => void;
}

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
        if (Math.abs(node.scrollTop - written) > FOREIGN_WRITE_PX) {
            stop();
            onYield?.();
            return;
        }
        const dt = Math.min(MAX_STEP_S, Math.max(0, (time - lastTime) / 1000));
        lastTime = time;
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
