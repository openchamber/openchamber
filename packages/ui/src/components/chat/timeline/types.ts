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
    message: string;
    confirmedAt?: number;
    fallbackTimestamp?: number;
};

export type ListMetrics = { readonly headerSize: number; readonly footerSize: number };

// Presentation-only props forwarded to the scroll container the list renders.
// Deliberately narrow: the list owns scroll and layout callbacks on that
// element, so only styling, focus and click-through are caller-controlled.
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
    // One step toward showing the anchor at its offset: `moved` when the
    // viewport had to scroll (the row may still be positioned from an
    // estimate), `aligned` when it already sits there, `missing` when the
    // message is not in the loaded timeline.
    alignViewportAnchor: (anchor: MessageViewportAnchor) => ViewportAnchorAlignment;
    // Whether the message has a row. A loaded reply has none while the prompt
    // that opens its turn is still in unloaded history.
    hasMessageRow: (messageId: string) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}
