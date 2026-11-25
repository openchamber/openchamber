import React from 'react';

import type { MessageListHandle } from '@/components/chat/timeline/types';
import { createFrameScheduler } from '@/lib/timing/frame';

interface ReplyJumpTargetOptions {
    scrollNode: HTMLElement | null;
    replyStartMessageIds: readonly string[];
    messageListRef: React.MutableRefObject<MessageListHandle | null>;
    rearmKey: unknown;
}

export const useReplyJumpTarget = ({
    scrollNode,
    replyStartMessageIds,
    messageListRef,
    rearmKey,
}: ReplyJumpTargetOptions) => {
    const [replyJumpTargetId, setReplyJumpTargetId] = React.useState<string | null>(null);
    const scheduleRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        if (!scrollNode || replyStartMessageIds.length === 0) {
            setReplyJumpTargetId(null);
            return;
        }
        const scheduler = createFrameScheduler(() => {
            const target = messageListRef.current?.findPreviousReplyStart(replyStartMessageIds) ?? null;
            setReplyJumpTargetId((current) => (current === target ? current : target));
        });
        scheduleRef.current = scheduler.schedule;
        scheduler.schedule();
        scrollNode.addEventListener('scroll', scheduler.schedule, { passive: true });
        const resizeObserver = globalThis.ResizeObserver
            ? new globalThis.ResizeObserver(scheduler.schedule)
            : null;
        resizeObserver?.observe(scrollNode);
        return () => {
            scheduler.cancel();
            scrollNode.removeEventListener('scroll', scheduler.schedule);
            resizeObserver?.disconnect();
            if (scheduleRef.current === scheduler.schedule) {
                scheduleRef.current = null;
            }
        };
    }, [messageListRef, rearmKey, replyStartMessageIds, scrollNode]);
    const scheduleRemeasure = React.useCallback(() => {
        scheduleRef.current?.();
    }, []);
    return { replyJumpTargetId, scheduleRemeasure };
};
