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
    isPending?: boolean;
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
    onCopyTurn?: () => Promise<boolean>;
    copiedMessage?: boolean;
    onCopyLink?: () => void;
    onSaveAsSnippet?: () => void;
    onSelectMessages?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void;
    onFork?: () => void;
    errorMessage?: string;
    errorResponseBody?: string;
    userMessagePart?: 'bubble' | 'actions';
    reviewTransferDirection?: ReviewTransferDirection | null;
    contextPinned?: boolean;
    contextPinPending?: boolean;
    onToggleContextPin?: () => void;
    footerProviderID?: string | null;
    footerModelName?: string;
    footerAgentName?: string;
    footerVariant?: string;
    extraActions?: MessageExtraAction[];
    promptOrigin?: PromptOrigin;
}

export type MessageExtraAction = {
    id: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
};
