import { findFollowStops } from './followStops';
import { resolveFollowStop } from './followScroll';

interface FollowLanding {
    target: number;
    stop: HTMLElement | null;
}

export const resolveFollowLanding = (
    node: HTMLElement,
    scroll: number,
    glideTarget: number,
    reply: HTMLElement | null,
    eligibility: WeakMap<HTMLElement, boolean>,
    footerSize: number,
    stopAfterUserMessage: boolean,
    wasFollowing: boolean,
): FollowLanding => {
    const visibleLength = node.clientHeight - footerSize;
    let target = glideTarget;
    let stop: HTMLElement | null = null;
    for (const candidate of findFollowStops(node, stopAfterUserMessage, reply)) {
        if (!eligibility.has(candidate.element)) eligibility.set(candidate.element, wasFollowing || scroll <= candidate.limit + 1);
        if (stop || eligibility.get(candidate.element) !== true) continue;
        const held = resolveFollowStop(target, candidate, visibleLength);
        if (!held.hold) continue;
        target = held.target;
        stop = candidate.element;
        eligibility.set(candidate.element, false);
    }
    return { target, stop };
};
