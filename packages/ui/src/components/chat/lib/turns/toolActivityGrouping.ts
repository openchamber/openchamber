import React from 'react';

import type { Part, ToolPart } from '@/lib/opencode/model';
import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import { readBackgroundSubagentChildID } from '@/lib/opencode/subagent-run';
import { readSessionNoticePart } from '@/lib/opencode/session-notices';
import { isQuestionTool, renderedPage } from '@/lib/opencode/tools';
import { isInvisibleText } from '@/lib/invisibleText';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { isToolRowShown } from './activityRows';
import type { ChatMessageEntry } from './types';

export interface ToolActivityGroupPlan {
    parts: ToolPart[];
    first: boolean;
    partial: boolean;
}

/** The plan of one turn, keyed by the id of every part it groups. */
export type ToolActivityPlan = ReadonlyMap<string, ToolActivityGroupPlan>;

export const EMPTY_TOOL_ACTIVITY_PLAN: ToolActivityPlan = new Map();

export const ToolActivityPlanContext = React.createContext<ToolActivityPlan | null>(null);

function canJoinActivity(part: ToolPart): boolean {
    if (!isToolRowShown(part) || isQuestionTool(part.tool)) return false;
    if (readSessionNoticePart(part) || renderedPage(part.tool, part.state)) return false;
    if (part.state.status === 'completed' && part.state.attachments?.length) return false;
    return true;
}

/** A shell or subagent call OpenCode settled while its job kept running. */
function isBackgroundCall(part: ToolPart): boolean {
    return Boolean(readBackgroundShellID(part) || readBackgroundSubagentChildID(part));
}

/** Interactive and in-flight calls retain their own visible rows. */
export function isGroupableTool(
    part: ToolPart,
    options?: { runningBackground?: ReadonlySet<string> },
): boolean {
    if (part.state.status !== 'completed' && part.state.status !== 'error') return false;
    if (!canJoinActivity(part)) return false;
    if (!isBackgroundCall(part)) return true;
    // Without live state a background call may still be running: keep its row.
    return options?.runningBackground ? !options.runningBackground.has(part.id) : false;
}

/** Background rows stay visible while their job runs and break the live tail. */
const canJoinLiveTail = (part: ToolPart): boolean => canJoinActivity(part) && !isBackgroundCall(part);

/**
 * The parts of a turn that draw a row, in order, for grouping. Empty text and
 * reasoning the model kept to itself draw nothing and must not break a run.
 */
export const toolActivityParts = (messages: readonly ChatMessageEntry[], showReasoningTraces: boolean): Part[] => (
    messages.flatMap((message) => (
        filterVisibleParts(message.parts, { includeReasoning: showReasoningTraces }).filter((part) => {
            if (isEmptyTextPart(part)) return false;
            if (part.type === 'reasoning' && part.time.end !== undefined && isInvisibleText(part.text)) return false;
            return true;
        })
    ))
);

/**
 * The calls whose background job still runs. They keep their own rows until
 * the job ends, wherever they sit in the turn.
 */
export function runningBackgroundToolIds(
    parts: readonly Part[],
    runningShells: ReadonlyMap<string, unknown>,
    activeSessionIds: ReadonlySet<string>,
): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const part of parts) {
        if (part.type !== 'tool') continue;
        const shellID = readBackgroundShellID(part);
        if (shellID) {
            if (runningShells.has(shellID)) ids.add(part.id);
            continue;
        }
        const childID = readBackgroundSubagentChildID(part);
        if (childID && activeSessionIds.has(childID)) ids.add(part.id);
    }
    return ids;
}

interface LiveToolTail {
    turnId: string;
    ids: string[];
    visible: Set<string>;
}

const sameIds = (a: readonly string[], b: readonly string[]) => (
    a.length === b.length && a.every((id, index) => id === b[index])
);

/** Keep visible calls in place when their results arrive. */
export function advanceLiveToolTail(previous: LiveToolTail, turnId: string, parts: readonly Part[], working: boolean): LiveToolTail {
    const tail: ToolPart[] = [];
    if (working) {
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (part.type !== 'tool' || !canJoinLiveTail(part)) break;
            tail.push(part);
        }
        tail.reverse();
    }
    const ids = tail.map((part) => part.id);
    const previousLast = previous.ids.at(-1);
    const previousEnd = previous.turnId === turnId && previousLast ? ids.indexOf(previousLast) : -1;
    let visible: Set<string>;
    if (previousEnd < 0) {
        visible = new Set(tail.filter((part) => part.state.status === 'pending' || part.state.status === 'running').map((part) => part.id));
        // Once the last call finishes, retain its row until more work arrives.
        if (tail.length > 0 && isGroupableTool(tail[tail.length - 1])) visible.add(tail[tail.length - 1].id);
    } else {
        const current = new Set(ids);
        visible = new Set([...previous.visible].filter((id) => current.has(id)));
        const added = tail.slice(previousEnd + 1);
        let toFold = added.length;
        for (const part of tail.slice(0, previousEnd + 1)) {
            if (!visible.has(part.id)) continue;
            if (part.state.status === 'pending' || part.state.status === 'running') break;
            if (toFold > 0) {
                visible.delete(part.id);
                toFold -= 1;
            }
        }
        for (const part of added) visible.add(part.id);
    }
    if (previous.turnId === turnId && sameIds(previous.ids, ids)
        && previous.visible.size === visible.size && [...visible].every((id) => previous.visible.has(id))) return previous;
    return { turnId, ids, visible };
}

/** This transient presentation state belongs to the mounted turn, not history. */
export function useLiveToolTail(turnId: string, parts: readonly Part[], working: boolean): ReadonlySet<string> {
    const [previous, setPrevious] = React.useState<LiveToolTail>(() => ({ turnId, ids: [], visible: new Set() }));
    const next = advanceLiveToolTail(previous, turnId, parts, working);
    if (next !== previous) setPrevious(next);
    return next.visible;
}

/** Groups the visible sequence, including runs that cross message boundaries. */
export function planToolActivity(
    parts: readonly Part[],
    partialStart: boolean,
    partialEnd = false,
    visibleTail?: ReadonlySet<string>,
    runningBackground?: ReadonlySet<string>,
): ToolActivityPlan {
    const groupableOptions = runningBackground ? { runningBackground } : undefined;
    const plan = new Map<string, ToolActivityGroupPlan>();
    let group: ToolPart[] = [];
    let startsAtBeginning = false;
    // A single finished call stays a direct row; one wrapper per call would be
    // pure noise, and a running call below it is no reason to add one.
    const flush = (atEnd = false) => {
        if (group.length > 1) {
            for (let index = 0; index < group.length; index += 1) {
                plan.set(group[index].id, { parts: group, first: index === 0, partial: (partialStart && startsAtBeginning) || (partialEnd && atEnd) });
            }
        }
        group = [];
    };
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.type === 'tool' && isGroupableTool(part, groupableOptions) && !visibleTail?.has(part.id)) {
            if (group.length === 0) startsAtBeginning = index === 0;
            group.push(part);
            continue;
        }
        flush();
    }
    flush(true);
    return plan;
}

export type ToolActivityPluralCategory = 'one' | 'few' | 'many' | 'other';

// A group keeps its disclosure across remounts and membership changes: parts
// join or leave it as the window changes and as calls settle, and the first
// part of a group can move when older rows are revealed. A logical group id,
// carried by every part ever seen in it, is what the open state belongs to.
const MAX_TRACKED_GROUP_PARTS = 5_000;
const groupIdByPartId = new Map<string, string>();
const openGroupIds = new Set<string>();
let nextGroupId = 1;

/** The logical id of the group these parts belong to, creating one if needed. */
export function trackToolActivityGroup(parts: readonly ToolPart[]): string {
    let groupId: string | undefined;
    for (const part of parts) {
        groupId = groupIdByPartId.get(part.id);
        if (groupId) break;
    }
    if (!groupId) groupId = `tool-group-${nextGroupId++}`;
    for (const part of parts) {
        if (groupIdByPartId.has(part.id)) continue;
        groupIdByPartId.set(part.id, groupId);
        if (groupIdByPartId.size > MAX_TRACKED_GROUP_PARTS) {
            const oldest = groupIdByPartId.keys().next().value;
            if (oldest !== undefined) groupIdByPartId.delete(oldest);
        }
    }
    return groupId;
}

/** Remembers whether the reader left this group open. */
export function setToolActivityGroupOpen(groupId: string, open: boolean): void {
    if (open) openGroupIds.add(groupId);
    else openGroupIds.delete(groupId);
}

export function isToolActivityGroupOpen(parts: readonly ToolPart[]): boolean {
    for (const part of parts) {
        const groupId = groupIdByPartId.get(part.id);
        if (groupId) return openGroupIds.has(groupId);
    }
    return false;
}

/**
 * The plural form a locale uses for `count`. Categories we do not translate
 * (`zero`, `two`) fall back to `other`.
 */
export function toolActivityPluralCategory(locale: string, count: number): ToolActivityPluralCategory {
    const category = new Intl.PluralRules(locale).select(count);
    return category === 'one' || category === 'few' || category === 'many' ? category : 'other';
}
