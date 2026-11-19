import type { FileMentionAutocompleteInputSource } from '../../fileMentionAutocompleteState';
import { collectKnownTokenNames } from '../../composer/language/prefixTokens';
import { hasSessionMention } from '../../sessionMentionResults';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

export const continuesSessionMention = (query: string, currentSessionId: string | null): boolean => {
    const { hasLoaded, activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    if (!hasLoaded) return false;
    return hasSessionMention(activeSessions, query, currentSessionId)
        || hasSessionMention(archivedSessions, query, currentSessionId);
};

export const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '$', skillNames, 'exact');
