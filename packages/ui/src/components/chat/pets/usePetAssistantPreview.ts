/**
 * Preview text of the last assistant reply, shared by the in-app pet and the
 * desktop overlay bridge. Reads session messages from the directory store
 * and collapses/truncates the reply the same way the Codex
 * `agent_turn_preview` does.
 */

import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { useDirectorySync, useSessionMessages } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Codex AGENT_NOTIFICATION_PREVIEW_GRAPHEMES. */
const PREVIEW_MAX_CHARS = 200;

const EMPTY_PARTS: Part[] = [];

function lastAssistantPreview(parts: readonly Part[]): string | null {
    const text = parts
        .filter((part): part is Part & { type: 'text' } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    const normalized = text.split(/\s+/).filter(Boolean).join(' ').trim();
    if (normalized) {
        return normalized.slice(0, PREVIEW_MAX_CHARS);
    }
    return null;
}

export function usePetAssistantPreview(): string | null {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const messages = useSessionMessages(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const lastAssistantId = React.useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                return messages[i].id;
            }
        }
        return null;
    }, [messages]);

    const assistantParts = useDirectorySync(
        React.useCallback(
            (state) => (lastAssistantId ? (state.part[lastAssistantId] ?? EMPTY_PARTS) : EMPTY_PARTS),
            [lastAssistantId],
        ),
        currentSessionDirectory ?? undefined,
    );

    return React.useMemo(() => lastAssistantPreview(assistantParts), [assistantParts]);
}
