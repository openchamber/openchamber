export const normalizeWheelDelta = (input: {
    deltaY: number;
    deltaMode: number;
    rootHeight?: number;
}): number => {
    if (input.deltaMode === 1) {
        return input.deltaY * 40;
    }
    if (input.deltaMode === 2) {
        return input.deltaY * (input.rootHeight ?? 120);
    }
    return input.deltaY;
};

export const shouldMarkBoundaryGesture = (input: {
    delta: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}): boolean => {
    const max = input.scrollHeight - input.clientHeight;
    if (max <= 1) {
        return true;
    }

    if (!input.delta) {
        return false;
    }

    if (input.delta < 0) {
        return input.scrollTop + input.delta <= 0;
    }

    const remaining = max - input.scrollTop;
    return input.delta > remaining;
};

export const boundaryTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement => {
    const current = target instanceof Element ? target : undefined;
    const nested = current?.closest('[data-scrollable]');
    if (!nested || nested === root) {
        return root;
    }
    if (!(nested instanceof HTMLElement)) {
        return root;
    }
    return nested;
};

export const shouldPauseAutoScrollOnWheel = (input: {
    root: HTMLElement;
    target: EventTarget | null;
    delta: number;
}): boolean => {
    if (input.delta >= 0) {
        return false;
    }

    const target = boundaryTarget(input.root, input.target);
    if (target === input.root) {
        return true;
    }

    return shouldMarkBoundaryGesture({
        delta: input.delta,
        scrollTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
    });
};

export const isNearTop = (scrollTop: number, threshold: number): boolean => {
    return scrollTop <= threshold;
};

export const isNearBottom = (distanceFromBottom: number, threshold: number): boolean => {
    return distanceFromBottom <= threshold;
};
