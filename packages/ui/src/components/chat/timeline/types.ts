import type React from 'react';
import type { MessageViewportAnchor, ViewportAnchorAlignment } from '../lib/scroll/messageViewportAnchor';
import type { TimelineEntry } from '../lib/turns/timelineEntries';
import type { TimelineRow as TimelineRowRecord } from '../lib/turns/timelineRows';

export type RenderEntry = TimelineEntry;
export type RenderRow = TimelineRowRecord;
export type TurnEntry = Extract<RenderEntry, { kind: 'turn' }>;

export type ToggleTurnActivity = (turnId: string) => void;

export type RetryOverlay = {
    sessionId: string;
    lastIdleAt: number | null;
    notice?: {
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    };
};

export type ListMetrics = { readonly headerSize: number; readonly footerSize: number };

export type TimelineScrollContainerProps = {
    className?: string;
    style?: React.CSSProperties;
    tabIndex?: number;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
    'data-scrollbar'?: string;
    'data-scroll-shadow'?: string;
};

export interface MessageListHandle {
    resolveUiPageMessageId: (messageId: string, partId: string) => string;
    scrollToUiPageRow: (messageId: string) => boolean;
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => MessageViewportAnchor | null;
    restoreViewportAnchor: (anchor: MessageViewportAnchor) => boolean;
    alignViewportAnchor: (anchor: MessageViewportAnchor) => ViewportAnchorAlignment;
    hasMessageRow: (messageId: string) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}
