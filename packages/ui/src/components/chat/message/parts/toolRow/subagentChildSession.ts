import React from 'react';
import type { Part, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { readTaskSessionIdFromOutput, readTaskSessionIdFromRecord, resolveRunningTaskChildSessionId } from '../taskToolModel';

const useRunningTaskChildSessionId = (part: ToolPartType | undefined, directory: string): string | undefined => {
    const startedAt = part?.state.status === 'running' ? part.state.time.start : undefined;
    const agent = part?.state.input.agent;
    const description = part?.state.input.description;
    const parentSessionID = part?.sessionID;
    const messageID = part?.messageID;
    const partID = part?.id;
    // The selector runs on every store change while a Task is running, so it
    // rescans only when the session list or this message's parts change.
    const selector = React.useMemo(() => {
        let lastSessions: State['session'] | undefined;
        let lastSiblings: Part[] | undefined;
        let lastResult: string | undefined;
        return (state: State): string | undefined => {
            if (!parentSessionID || !messageID || !partID || startedAt === undefined) return undefined;
            const siblings = state.part[messageID];
            if (state.session === lastSessions && siblings === lastSiblings) return lastResult;
            lastSessions = state.session;
            lastSiblings = siblings;
            lastResult = resolveRunningTaskChildSessionId({
                sessions: state.session,
                parentSessionID,
                startedAt,
                agent,
                description,
                siblingParts: siblings,
                partID,
            });
            return lastResult;
        };
    }, [agent, description, messageID, parentSessionID, partID, startedAt]);
    return useDirectorySync(selector, directory || undefined);
};

/**
 * The child session a subagent call runs in. Progress/result metadata is the
 * canonical join. Older parts keep their output IDs, and a resumed
 * call can name its child in input.sessionID. A parent message loaded over
 * REST mid-run lacks the progress-only join (see
 * resolveRunningTaskChildSessionId); the child is then recovered from the
 * session records until the authoritative id arrives.
 */
export const useSubagentChildSessionId = (part: ToolPartType, directory: string): string | undefined => {
    const state = part.state;
    const authoritative = React.useMemo(() => {
        if (state.status === 'pending') return readTaskSessionIdFromRecord({ sessionID: state.input.sessionID });
        return readTaskSessionIdFromRecord(state.metadata)
            ?? readTaskSessionIdFromOutput(state.status === 'running' ? undefined : state.output)
            ?? readTaskSessionIdFromRecord({ sessionID: state.input.sessionID });
    }, [state]);
    const inferred = useRunningTaskChildSessionId(!authoritative && state.status === 'running' ? part : undefined, directory);
    return authoritative ?? inferred;
};
