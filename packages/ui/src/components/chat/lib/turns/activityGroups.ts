import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import {
    executeNamespace,
    isExecuteTool,
    isFileChangeTool,
    isExplorationTool,
    isQuestionTool,
    isShellTool,
    isShownInPlace,
    isSkillTool,
    isWebTool,
    normalizeToolName,
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

export interface ActivityGroupCounts {
    reads: number;
    searches: number;
    skills: number;
    web: number;
    commands: number;
    other: ReadonlyMap<string, number>;
    failed: number;
}

export const countActivityGroup = (parts: readonly Part[]): ActivityGroupCounts => {
    const other = new Map<string, number>();
    const counts: ActivityGroupCounts = { reads: 0, searches: 0, skills: 0, web: 0, commands: 0, other, failed: 0 };
    for (const part of parts) {
        if (part.type !== 'tool') continue;
        if (part.state.status === 'error') counts.failed += 1;
        const name = normalizeToolName(part.tool);
        if (isFileChangeTool(name)) continue;
        if (isShellTool(name)) counts.commands += 1;
        else if (isSkillTool(name)) counts.skills += 1;
        else if (isWebTool(name)) counts.web += 1;
        else if (isExplorationTool(name)) counts[name === 'read' ? 'reads' : 'searches'] += 1;
        else {
            const namespace = isExecuteTool(name) && part.state.status !== 'pending' ? executeNamespace(part.state.metadata) : undefined;
            const label = namespace ?? name;
            other.set(label, (other.get(label) ?? 0) + 1);
        }
    }
    return counts;
};
