import type { FileMentionAutocompleteInputSource } from '../../fileMentionAutocompleteState';
import { collectKnownTokenNames } from '../../composer/language/prefixTokens';
import { hasSessionMention } from '../../sessionMentionResults';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

// Asks the snapshot the `@` picker ranks, which it loads when it opens, with
// the same session left out, so the picker never stays open over nothing.
export const continuesSessionMention = (query: string, currentSessionId: string | null): boolean => {
    const { hasLoaded, activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    if (!hasLoaded) return false;
    return hasSessionMention(activeSessions, query, currentSessionId)
        || hasSessionMention(archivedSessions, query, currentSessionId);
};

/**
 * Skills the user named with `$name`. Matched against the registry's exact
 * casing, since the name is echoed back to the model as a skill to load.
 */
export const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '$', skillNames, 'exact');
