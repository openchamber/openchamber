import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ChatViewProps = {
    active?: boolean;
    autoOpenDraft?: boolean;
    readOnly?: boolean;
};

export const ChatView: React.FC<ChatViewProps> = ({ active = true, autoOpenDraft = true, readOnly = false }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer active={active} autoOpenDraft={autoOpenDraft} readOnly={readOnly} />
        </ChatErrorBoundary>
    );
};
