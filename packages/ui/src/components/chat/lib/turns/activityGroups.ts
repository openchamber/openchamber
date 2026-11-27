import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import {
    executeToolCalls,
    isExecuteTool,
    isFileChangeTool,
    isExplorationTool,
    isQuestionTool,
    isShellTool,
    isShownInPlace,
    isSubagentTool,
    isTodoWriteTool,
    isWebTool,
    normalizeToolName,
    opencodeNamespaceTool,
} from '@/lib/opencode/tools';
import { isInvisibleText } from '@/lib/invisibleText';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
import { isToolRowShown } from './activityRows';
import type { ChatMessageEntry } from './types';

export type ActivityPhase = 'explore' | 'edit' | 'run' | 'other';

export interface ActivitySegment {
    key: string;
    phase: ActivityPhase | null;
    grouped: boolean;
    parts: Part[];
    messageIds: string[];
}

type SegmentedPart = { part: Part; messageId: string };
type Run = { phase: ActivityPhase | null; items: SegmentedPart[] };

const MAX_ABSORBED_LOOKUPS = 5;

export const isStandalonePart = (part: ToolPart): boolean => (
    isSessionNoticePart(part)
    || isStandaloneTool(part.tool)
    || isQuestionTool(part.tool)
    || isShownInPlace(part.tool, part.state)
    || (isShellTool(part.tool) && readBackgroundShellID(part) !== undefined)
);

const phaseOf = (part: ToolPart): ActivityPhase => {
    if (isFileChangeTool(part.tool)) return 'edit';
    if (isShellTool(part.tool)) return 'run';
    if (isExplorationTool(part.tool) || isWebTool(part.tool)) return 'explore';
    return 'other';
};

export const isActivityRowDrawn = (part: Part, messageDone: boolean): boolean => {
    if (part.type === 'reasoning') return (part.time?.end === undefined && !messageDone) || !isInvisibleText(part.text);
    return part.type === 'tool' && isToolRowShown(part);
};

const callCount = (run: Run): number => run.items.filter(({ part }) => part.type === 'tool').length;

const mergeNeighbours = (runs: readonly Run[]): Run[] => {
    const merged: Run[] = [];
    for (const run of runs) {
        const previous = merged.at(-1);
        if (previous && run.phase !== null && previous.phase === run.phase) previous.items.push(...run.items);
        else merged.push({ phase: run.phase, items: [...run.items] });
    }
    return merged;
};

const absorbLookups = (runs: readonly Run[], live: boolean): Run[] => {
    const absorbed: Run[] = [];
    let carried: SegmentedPart[] = [];
    runs.forEach((run, index) => {
        const previous = absorbed.at(-1);
        const next = runs[index + 1];
        const small = run.phase === 'explore' && callCount(run) <= MAX_ABSORBED_LOOKUPS;
        if (small && next?.phase === 'edit') {
            carried = run.items;
            return;
        }
        const stillGrowing = live && index === runs.length - 1;
        if (small && !stillGrowing && (previous?.phase === 'edit' || previous?.phase === 'run')) {
            previous.items.push(...run.items);
            return;
        }
        absorbed.push({ phase: run.phase, items: [...carried, ...run.items] });
        carried = [];
    });
    return absorbed;
};

export const visibleMessageParts = (message: ChatMessageEntry, showReasoning: boolean): Part[] => (
    filterVisibleParts(message.parts, { includeReasoning: showReasoning }).filter((part) => !isEmptyTextPart(part))
);

export const segmentActivity = (messages: readonly ChatMessageEntry[], showReasoning: boolean, live: boolean): ActivitySegment[] => {
    const runs: Run[] = [];
    let thoughts: SegmentedPart[] = [];
    const pushAlone = (items: SegmentedPart[]) => {
        for (const item of items) runs.push({ phase: null, items: [item] });
    };
    const releaseThoughts = () => {
        pushAlone(thoughts);
        thoughts = [];
    };
    for (const message of messages) {
        for (const part of visibleMessageParts(message, showReasoning)) {
            const item = { part, messageId: message.info.id };
            if (part.type === 'reasoning') {
                const open = runs.at(-1);
                if (open && open.phase !== null) open.items.push(item);
                else thoughts.push(item);
                continue;
            }
            if (part.type !== 'tool' || isStandalonePart(part)) {
                releaseThoughts();
                pushAlone([item]);
                continue;
            }
            const phase = phaseOf(part);
            const previous = runs.at(-1);
            const items = [...thoughts, item];
            thoughts = [];
            if (previous && previous.phase !== null && phase === 'other') previous.items.push(...items);
            else if (previous && previous.phase === 'other') {
                previous.phase = phase;
                previous.items.push(...items);
            } else runs.push({ phase, items });
        }
    }
    releaseThoughts();
    return mergeNeighbours(absorbLookups(mergeNeighbours(runs), live)).map(({ phase, items }, index, all) => ({
        key: `group:${items[0].part.id}`,
        phase,
        grouped: phase !== null && ((live && index === all.length - 1) || items.filter(({ part }) => isActivityRowDrawn(part, false)).length > 1),
        parts: items.map(({ part }) => part),
        messageIds: [...new Set(items.map(({ messageId }) => messageId))],
    }));
};

interface ActivityGroupCounts {
    commands: number;
    subagents: number;
    explored: boolean;
    searchedWeb: boolean;
}

const EXPLORING = new Set(['list', 'lsp', 'codesearch']);
const UNCOUNTED = new Set([
    'todoread', 'plan_enter', 'plan_exit', 'structuredoutput', 'invalid', 'session_rename', 'session_move', 'models',
    'openchamber_memory', 'openchamber_knowledge', 'openchamber_usage', 'openchamber_notify',
]);

const isUncounted = (tool: string): boolean => {
    const name = normalizeToolName(tool);
    const namespace = tool.trim().toLowerCase().split('.')[0];
    return isTodoWriteTool(name) || isQuestionTool(name) || UNCOUNTED.has(name) || UNCOUNTED.has(namespace)
        || UNCOUNTED.has(opencodeNamespaceTool(tool) ?? '');
};

export const countActivityGroup = (parts: readonly Part[]): ActivityGroupCounts => {
    const counts: ActivityGroupCounts = { commands: 0, subagents: 0, explored: false, searchedWeb: false };
    for (const part of parts) {
        if (part.type !== 'tool') continue;
        const name = normalizeToolName(part.tool);
        if (isFileChangeTool(name) || isUncounted(part.tool)) continue;
        const scriptCalls = isExecuteTool(name) && part.state.status !== 'pending' ? executeToolCalls(part.state.metadata) : [];
        if (scriptCalls.length > 0 && scriptCalls.every(({ tool }) => isUncounted(tool))) continue;
        if (isSubagentTool(name)) counts.subagents += 1;
        else if (isWebTool(name)) counts.searchedWeb = true;
        else if (isExplorationTool(name) || EXPLORING.has(name)) counts.explored = true;
        else counts.commands += 1;
    }
    return counts;
};
