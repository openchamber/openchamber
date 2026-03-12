import type { MessageStreamLifecycle } from "../types/sessionTypes";

export type { MessageStreamLifecycle };

export const touchStreamingLifecycle = (
    source: Map<string, MessageStreamLifecycle>,
    messageId: string
): Map<string, MessageStreamLifecycle> => {
    const now = Date.now();
    const existing = source.get(messageId);

    const next = new Map(source);
    next.set(messageId, {
        phase: 'streaming',
        startedAt: existing?.startedAt ?? now,
        lastUpdateAt: now,
    });

    return next;
};

export const removeLifecycleEntries = (
    source: Map<string, MessageStreamLifecycle>,
    ids: Iterable<string>
): Map<string, MessageStreamLifecycle> => {
    const idsArray = Array.from(ids);
    const shouldClone = idsArray.some((id) => source.has(id));

    if (!shouldClone) {
        return source;
    }

    const next = new Map(source);
    idsArray.forEach((id) => {
        next.delete(id);
    });

    return next;
};

const lifecycleCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const clearLifecycleCompletionTimer = (messageId: string) => {
    const timer = lifecycleCompletionTimers.get(messageId);
    if (timer) {
        clearTimeout(timer);
        lifecycleCompletionTimers.delete(messageId);
    }
};

export const clearLifecycleTimersForIds = (ids: Iterable<string>) => {
    for (const id of ids) {
        clearLifecycleCompletionTimer(id);
    }
};
