import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { AgentLoopStatusView } from '@/components/agentloop';
import { useSessionStore } from '@/stores/useSessionStore';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';

export const ChatView: React.FC = () => {
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const agentLoop = useAgentLoopStore((state) =>
        currentSessionId ? state.getLoopByParentSession(currentSessionId) : undefined
    );

    if (agentLoop) {
        return <AgentLoopStatusView loopId={agentLoop.id} />;
    }

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer />
        </ChatErrorBoundary>
    );
};
