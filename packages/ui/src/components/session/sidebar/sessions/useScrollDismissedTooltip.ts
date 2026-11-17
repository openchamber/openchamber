
import React from 'react';
import type { Tooltip } from '@/components/ui/tooltip';

type TooltipProps = React.ComponentProps<typeof Tooltip>;
type TooltipActions = NonNullable<NonNullable<TooltipProps['actionsRef']>['current']>;
type TooltipOpenChange = NonNullable<TooltipProps['onOpenChange']>;

const SCROLL_SETTLE_MS = 150;
const SCROLL_LISTENER = { capture: true, passive: true } as const;

let lastScroll: { target: EventTarget | null; at: number } | null = null;
const recordingDocuments = new WeakSet<Document>();

const recordScroll = (event: Event) => {
    lastScroll = { target: event.target, at: performance.now() };
};

const scrolls = (target: EventTarget | null, element: Element): boolean =>
    target instanceof Node && target.contains(element);

type ScrollDismissedTooltip = {
    actionsRef: React.RefObject<TooltipActions | null>;
    onOpenChange: TooltipOpenChange;
};

export function useScrollDismissedTooltip(): ScrollDismissedTooltip {
    const actionsRef = React.useRef<TooltipActions | null>(null);
    const stopWatchingRef = React.useRef<(() => void) | null>(null);

    React.useEffect(() => {
        if (!recordingDocuments.has(document)) {
            recordingDocuments.add(document);
            document.addEventListener('scroll', recordScroll, SCROLL_LISTENER);
        }
        return () => stopWatchingRef.current?.();
    }, []);

    const onOpenChange = React.useCallback<TooltipOpenChange>((open, details) => {
        stopWatchingRef.current?.();
        stopWatchingRef.current = null;
        const trigger = details.trigger;
        if (!open || !trigger) return;

        if (lastScroll && performance.now() - lastScroll.at < SCROLL_SETTLE_MS && scrolls(lastScroll.target, trigger)) {
            details.cancel();
            return;
        }

        const closeOnScroll = (event: Event) => {
            if (scrolls(event.target, trigger)) actionsRef.current?.close();
        };
        document.addEventListener('scroll', closeOnScroll, SCROLL_LISTENER);
        stopWatchingRef.current = () => document.removeEventListener('scroll', closeOnScroll, SCROLL_LISTENER);
    }, []);

    return { actionsRef, onOpenChange };
}
