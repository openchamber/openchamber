import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ChatViewProps = {
    active?: boolean;
    readOnly?: boolean;
    pinnedSession?: { sessionId: string; directory: string | null };
    registerParentSessionBack?: (handler: (() => void) | null) => void;
};

export const ChatView: React.FC<ChatViewProps> = ({
    active = true,
    readOnly = false,
    pinnedSession,
    registerParentSessionBack,
}) => {
    const currentSessionId = useSessionUIStore((state) => (pinnedSession ? null : state.currentSessionId));

    return (
        <ChatErrorBoundary sessionId={pinnedSession?.sessionId ?? currentSessionId ?? undefined}>
            <ChatContainer
                active={active}
                readOnly={readOnly}
                pinnedSession={pinnedSession}
                registerParentSessionBack={registerParentSessionBack}
            />
        </ChatErrorBoundary>
    );
};
