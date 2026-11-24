import type { Part, Session, ToolInput } from '@/lib/opencode/model';

import { unwrapBackgroundResult } from '@/lib/opencode/background-result';
import { isSubagentTool, normalizeToolName } from '@/lib/opencode/tools';

import { capToolOutputText } from '../toolRenderers';
import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';

const normalizeSessionIdCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const readTaskSessionIdFromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return normalizeSessionIdCandidate(record.sessionID) ?? normalizeSessionIdCandidate(record.sessionId);
};

export const resolveRunningTaskChildSessionId = (options: {
    sessions: readonly Session[];
    parentSessionID: string;
    startedAt: number;
    agent: ToolInput[string] | undefined;
    description: ToolInput[string] | undefined;
    siblingParts: readonly Part[] | undefined;
    partID: string;
}): string | undefined => {
    const { sessions, parentSessionID, startedAt, agent, description, siblingParts, partID } = options;
    let claimed: Set<string> | undefined;
    for (const sibling of siblingParts ?? []) {
        if (sibling.id === partID || sibling.type !== 'tool' || !isSubagentTool(normalizeToolName(sibling.tool))) continue;
        const siblingSessionID = sibling.state.status === 'pending'
            ? undefined
            : readTaskSessionIdFromRecord(sibling.state.metadata);
        if (!siblingSessionID) continue;
        claimed ??= new Set();
        claimed.add(siblingSessionID);
    }

    const candidates = sessions.filter((session) => session.parentID === parentSessionID
        && session.time.created >= startedAt
        && (agent === undefined || session.agent === undefined || session.agent === agent)
        && !claimed?.has(session.id));
    if (candidates.length === 1) return candidates[0].id;
    if (description === undefined) return undefined;
    const titled = candidates.filter((session) => session.title === description);
    return titled.length === 1 ? titled[0].id : undefined;
};

const readTaskMetadataSessionId = (output: string): string | undefined => {
    const blockMatch = output.match(/<task_metadata>\s*([\s\S]*?)\s*<\/task_metadata>/i);
    if (!blockMatch?.[1]) return undefined;

    try {
        return readTaskSessionIdFromRecord(JSON.parse(blockMatch[1].trim()));
    } catch {
        return undefined;
    }
};

export const readTaskSessionIdFromOutput = (output: string | undefined): string | undefined => {
    if (typeof output !== 'string' || output.trim().length === 0) return undefined;
    const metadataSessionId = readTaskMetadataSessionId(output);
    if (metadataSessionId) return metadataSessionId;

    const taskMatch = output.match(/task_id\s*:\s*([\w-]+)/i);
    const sessionMatch = output.match(/session[_\s-]?id\s*:\s*([\w-]+)/i);
    const candidate = taskMatch?.[1] ?? sessionMatch?.[1];
    if (candidate) return normalizeSessionIdCandidate(candidate);
    return normalizeSessionIdCandidate(readTaskTagSessionIdFromOutput(output));
};

const stripTaskMetadataFromOutput = (output: string): string => {
    return output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '').trimEnd();
};

const TASK_ENVELOPE_OPEN_TAG_PATTERN = /^\s*<task(?:\s[^>]*)?>/i;
const TASK_RESULT_BLOCK_PATTERN = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i;

// external: #3238 Completed task output unwraps only a complete leading task-result envelope.
const unwrapTaskResultEnvelope = (output: string): string => {
    if (!TASK_ENVELOPE_OPEN_TAG_PATTERN.test(output)) return output;
    const resultBlock = output.match(TASK_RESULT_BLOCK_PATTERN);
    if (!resultBlock) return output;
    return resultBlock[1];
};

// external: #4066 OpenCode subagent results unwrap only when the whole output is one envelope.
const unwrapSubagentEnvelope = (output: string): string => unwrapBackgroundResult(output, 'subagent') ?? output;

// external: #2265 Bound task output before Markdown parsing to avoid renderer allocation crashes.
export const prepareTaskToolOutput = (output: string | undefined): string => {
    if (!output) return '';
    return capToolOutputText(stripTaskMetadataFromOutput(unwrapSubagentEnvelope(unwrapTaskResultEnvelope(output))));
};
