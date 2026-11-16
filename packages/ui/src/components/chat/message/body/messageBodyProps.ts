import type React from 'react';
import type { Part } from '@/lib/opencode/model';
import type { PromptOrigin } from '@/lib/opencode/prompt-origin';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from '../types';
import type { TurnGroupingContext } from '../../lib/turns/types';

export interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;


    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    /** Copies the whole turn's reply; the turn footer uses it instead of `onCopyMessage`. */
    onCopyTurn?: () => Promise<boolean>;
    copiedMessage?: boolean;
    /** Copies a link to this message; absent where the surface has no message links. */
    onCopyLink?: () => void;
    /** Opens "Save as snippet" with this user message's text. */
    onSaveAsSnippet?: () => void;
    onSelectMessages?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void;
    onFork?: () => void;
    errorMessage?: string;
    /** Raw provider response behind `errorMessage`, shown as collapsed details. */
    errorResponseBody?: string;
    /** A user message renders as two siblings: the bubble, and the actions row under it. */
    userMessagePart?: 'bubble' | 'actions';
    reviewTransferDirection?: ReviewTransferDirection | null;
    contextPinned?: boolean;
    contextPinPending?: boolean;
    onToggleContextPin?: () => void;
    footerProviderID?: string | null;
    footerModelName?: string;
    footerAgentName?: string;
    footerVariant?: string;
    /** Actions installed extensions contribute for this message's role; rendered after the built-ins. */
    extraActions?: MessageExtraAction[];
    /** The session whose agent sent this user message, linked at the foot of the bubble. */
    promptOrigin?: PromptOrigin;
}

/** One extension action on a message: an icon button on hover, a labelled row in the touch sheet. */
export type MessageExtraAction = {
    id: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
};
