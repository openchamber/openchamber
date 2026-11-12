import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ChatViewProps = {
    active?: boolean;
    readOnly?: boolean;
    /** Shows this session instead of the app's selection (see ChatContainer). */
    pinnedSession?: { sessionId: string; directory: string | null };
};

export const ChatView: React.FC<ChatViewProps> = ({
    active = true,
    readOnly = false,
    pinnedSession,
}) => {
    const currentSessionId = useSessionUIStore((state) => (pinnedSession ? null : state.currentSessionId));

    return (
        <ChatErrorBoundary sessionId={pinnedSession?.sessionId ?? currentSessionId ?? undefined}>
            <ChatContainer
                active={active}
                readOnly={readOnly}
                pinnedSession={pinnedSession}
            />
        </ChatErrorBoundary>
    );
};
