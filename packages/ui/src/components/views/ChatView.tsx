import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const ChatView: React.FC = () => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer />
        </ChatErrorBoundary>
    );
};
