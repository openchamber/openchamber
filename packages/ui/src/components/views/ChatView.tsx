import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { AgentLoopStatusView } from '@/components/agentloop';
import { useSessionStore } from '@/stores/useSessionStore';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';

export const ChatView: React.FC = () => {
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const agentLoopId = useAgentLoopStore((state) => {
        if (!currentSessionId) return undefined;
        for (const loop of state.loops.values()) {
            if (loop.parentSessionId === currentSessionId) return loop.id;
        }
        return undefined;
    });

    if (agentLoopId) {
        return <AgentLoopStatusView loopId={agentLoopId} />;
    }

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            <ChatContainer />
        </ChatErrorBoundary>
    );
};
