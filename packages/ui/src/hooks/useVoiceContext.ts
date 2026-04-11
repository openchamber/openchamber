import { useEffect, useRef } from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionPermissions, useSessionTextMessages } from '@/sync/sync-context';
import { voiceHooks, isVoiceSessionStarted } from '@/lib/voice';

/**
 * Hook that syncs session events (messages, permissions) to the voice agent.
 * Call this inside VoiceProvider to enable session awareness during voice.
 */
export function useVoiceContext() {
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const messages = useSessionTextMessages(currentSessionId ?? '');
    const permissions = useSessionPermissions(currentSessionId ?? '');

    // Track last seen message count to only forward new messages
    const lastMessageCountRef = useRef(0);

    // Forward new messages to voice agent
    useEffect(() => {
        if (!currentSessionId || !messages || messages.length === 0 || !isVoiceSessionStarted()) return;

        const currentCount = messages.length;
        if (currentCount <= lastMessageCountRef.current) return;

        // Get only new messages (messages since last check)
        const newMessages = messages.slice(lastMessageCountRef.current);
        lastMessageCountRef.current = currentCount;

        const formattedMessages = newMessages.map(m => ({
            role: m.role ?? '',
            content: m.text,
        }));

        voiceHooks.onMessages(currentSessionId, formattedMessages);
    }, [currentSessionId, messages]);

    // Forward permission requests to voice agent
    useEffect(() => {
        if (!currentSessionId || !permissions || permissions.length === 0) return;
        if (!isVoiceSessionStarted()) return;

        const request = permissions[0];
        if (!request) return;

        voiceHooks.onPermissionRequested(
            currentSessionId,
            request.id,
            request.permission,
            request.metadata
        );
    }, [currentSessionId, permissions]);

    // Reset message count when session changes
    useEffect(() => {
        lastMessageCountRef.current = 0;
    }, [currentSessionId]);
}
