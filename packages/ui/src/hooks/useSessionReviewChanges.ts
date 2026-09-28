/**
 * The files a session changed, for the diff panel when the directory is not a
 * Git repository.
 *
 * A session's own transcript is only part of the story: a subagent runs in a
 * child session (`session.parentID`) and its edits land in the same working
 * tree, so they belong in the review. This walks the whole session tree —
 * parent and every descendant — through the same `summarizeLiveActivity`
 * detection the per-turn "Changed files" list uses, and loads the children's
 * transcripts on demand (opening a session does not load its subagents).
 *
 * This is the fallback the diff panel reaches for without Git; a repository
 * still uses `git status`.
 */

import React from 'react';

import {
    collectDescendantSessionIds,
    collectSessionFileChanges,
    type SessionFileChange,
} from '@/components/chat/lib/turns/sessionChanges';
import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import type { Part, Session } from '@/lib/opencode/model';
import { getImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { useDirectorySync, useSessionMessageRecords } from '@/sync/sync-context';
import type { State } from '@/sync/types';

const EMPTY_SESSIONS: string[] = [];
const EMPTY_ENTRIES: ChatMessageEntry[] = [];
const EMPTY_CHANGES: SessionFileChange[] = [];
const EMPTY_PARTS: Part[] = [];

/** A runaway tree must not make the panel pull hundreds of transcripts. */
const MAX_DESCENDANT_SESSIONS = 64;

const selectDescendants = (sessions: readonly Session[], rootId: string): string[] => {
    const descendants = collectDescendantSessionIds(sessions, rootId);
    return descendants.length > MAX_DESCENDANT_SESSIONS
        ? descendants.slice(0, MAX_DESCENDANT_SESSIONS)
        : descendants;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index]);

const sameEntries = (left: readonly ChatMessageEntry[], right: readonly ChatMessageEntry[]): boolean =>
    left.length === right.length
    && left.every((entry, index) => entry.info === right[index]?.info && entry.parts === right[index]?.parts);

/** Side chains run during the parent turn; timestamp order reads as chronology. */
const byCreatedAt = (left: ChatMessageEntry, right: ChatMessageEntry): number =>
    (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0);

export function useSessionReviewChanges(
    sessionID: string | null | undefined,
    directory: string | null | undefined,
    enabled: boolean,
): SessionFileChange[] {
    const parentEntries = useSessionMessageRecords(
        enabled ? sessionID ?? '' : '',
        directory ?? undefined,
        { enabled },
    );

    const descendantSelector = React.useMemo(() => {
        let previous: string[] = EMPTY_SESSIONS;
        return (state: State): string[] => {
            if (!enabled || !sessionID) return EMPTY_SESSIONS;
            const next = selectDescendants(state.session, sessionID);
            if (sameIds(previous, next)) return previous;
            previous = next;
            return next;
        };
    }, [enabled, sessionID]);
    const descendantSessionIds = useDirectorySync(descendantSelector, directory ?? undefined);

    const childEntriesSelector = React.useMemo(() => {
        let previous: ChatMessageEntry[] = EMPTY_ENTRIES;
        return (state: State): ChatMessageEntry[] => {
            if (descendantSessionIds.length === 0) return EMPTY_ENTRIES;
            const next: ChatMessageEntry[] = [];
            for (const childId of descendantSessionIds) {
                for (const info of state.message[childId] ?? []) {
                    next.push({ info, parts: state.part[info.id] ?? EMPTY_PARTS });
                }
            }
            if (sameEntries(previous, next)) return previous;
            previous = next;
            return next;
        };
    }, [descendantSessionIds]);
    const childEntries = useDirectorySync(childEntriesSelector, directory ?? undefined);

    React.useEffect(() => {
        if (!enabled || !directory || descendantSessionIds.length === 0) return;
        const loader = getImperativeSessionMessageLoader();
        if (!loader) return;
        for (const childId of descendantSessionIds) {
            void loader.ensure({ directory, sessionID: childId });
        }
    }, [descendantSessionIds, directory, enabled]);

    return React.useMemo(() => {
        if (!enabled) return EMPTY_CHANGES;
        const entries = [...parentEntries, ...childEntries];
        if (entries.length === 0) return EMPTY_CHANGES;
        return collectSessionFileChanges(entries.sort(byCreatedAt), directory);
    }, [childEntries, directory, enabled, parentEntries]);
}
