/**
 * Background subagent runs that are working right now.
 *
 * A `subagent: true` command leaves nothing in the parent's transcript until
 * the job reports back (see `@/lib/opencode/subagent-run`), so the timeline
 * would show nothing while the subagent works. The live channel that does know
 * is the child session's status: a busy child of this session is a running
 * job. Children a `subagent` tool call already shows as its own row are left to
 * that row, and a child whose report has arrived is shown by the report.
 */

import React from 'react';

import { isFinalToolStatus, type Message, type Part, type Session, type SyntheticMessage } from '@/lib/opencode/model';
import { readSubagentRun, runningSubagentRunMessage } from '@/lib/opencode/subagent-run';
import { isSubagentTool, subagentSessionId } from '@/lib/opencode/tools';
import { useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';

import type { ChatMessageEntry } from './turns/types';

const EMPTY_RUNS: SyntheticMessage[] = [];

const isBusy = (state: Pick<State, 'session_status'>, sessionID: string): boolean => {
    const status = state.session_status[sessionID];
    return status !== undefined && status.type !== 'idle';
};

/**
 * What the parent's transcript already accounts for: children whose report
 * arrived, children a subagent tool call names, and the time from which a
 * running tool call without its child id yet may own any new child.
 */
const accountedChildren = (state: Pick<State, 'part'>, messages: readonly Message[]) => {
    const known = new Set<string>();
    let unjoinedCallSince: number | undefined;
    for (const message of messages) {
        const run = readSubagentRun(message);
        if (run) {
            known.add(run.childSessionID);
            continue;
        }
        if (message.role !== 'assistant') continue;
        for (const part of state.part[message.id] ?? []) {
            if (part.type !== 'tool' || !isSubagentTool(part.tool)) continue;
            const childID = part.state.status === 'pending' ? undefined : subagentSessionId(part.state.metadata);
            if (childID) {
                known.add(childID);
            } else if (!isFinalToolStatus(part.state.status)) {
                const start = part.state.status === 'running' ? part.state.time.start : message.time.created;
                unjoinedCallSince = Math.min(unjoinedCallSince ?? start, start);
            }
        }
    }
    return { known, unjoinedCallSince };
};

export const selectRunningSubagentRuns = (
    state: Pick<State, 'session' | 'session_status' | 'message' | 'part'>,
    parentSessionID: string,
): SyntheticMessage[] => {
    const busyChildren: Session[] = [];
    for (const session of state.session) {
        if (session.parentID === parentSessionID && isBusy(state, session.id)) busyChildren.push(session);
    }
    if (busyChildren.length === 0) return EMPTY_RUNS;

    const { known, unjoinedCallSince } = accountedChildren(state, state.message[parentSessionID] ?? []);
    const runs: SyntheticMessage[] = [];
    for (const child of busyChildren) {
        if (known.has(child.id)) continue;
        if (unjoinedCallSince !== undefined && child.time.created >= unjoinedCallSince) continue;
        runs.push(runningSubagentRunMessage(parentSessionID, child));
    }
    return runs.length === 0 ? EMPTY_RUNS : runs;
};

const EMPTY_PARTS: Part[] = [];
const entryByRun = new WeakMap<SyntheticMessage, ChatMessageEntry>();

const entryForRun = (run: SyntheticMessage): ChatMessageEntry => {
    let entry = entryByRun.get(run);
    if (!entry) {
        entry = { info: run, parts: EMPTY_PARTS };
        entryByRun.set(run, entry);
    }
    return entry;
};

/** The timeline with each running run placed where its child session started. */
export const withRunningSubagentRuns = (
    messages: ChatMessageEntry[],
    runs: readonly SyntheticMessage[],
): ChatMessageEntry[] => {
    if (runs.length === 0) return messages;
    const result = [...messages];
    for (const run of runs) {
        const index = result.findIndex((message) => message.info.time.created > run.time.created);
        result.splice(index < 0 ? result.length : index, 0, entryForRun(run));
    }
    return result;
};

const sameRuns = (left: readonly SyntheticMessage[], right: readonly SyntheticMessage[]): boolean =>
    left.length === right.length
    && left.every((run, index) => run.id === right[index]?.id && run.description === right[index]?.description);

/** The running subagent runs of a session, stable across unrelated store updates. */
export const useRunningSubagentRuns = (sessionID: string, directory?: string): SyntheticMessage[] => {
    const selector = React.useMemo(() => {
        let previous = EMPTY_RUNS;
        return (state: State): SyntheticMessage[] => {
            if (!sessionID) return EMPTY_RUNS;
            const next = selectRunningSubagentRuns(state, sessionID);
            if (sameRuns(previous, next)) return previous;
            previous = next;
            return next;
        };
    }, [sessionID]);
    return useDirectorySync(selector, directory);
};
