import { getToolMetadata } from '@/lib/toolHelpers';
import type { ToolInput, ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { isTodoWriteTool, isOpenChamberTool, openChamberCallSummary, toolDescription, type ToolDescription } from '@/lib/opencode/tools';
import { toolContentShellEnvelope } from '@/lib/opencode/toolContentShells';
import { opencodeCallSucceeded, opencodeToolVerb } from '../opencodeToolResult';
import { openChamberVerbKey, parseOpenChamberEnvelope, secretRowView } from '../openChamberToolEnvelope';
import type { ToolStateWithMetadata } from './types';
import { getRelativePath } from './toolPaths';

export const getToolDescriptionPath = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string): string | null => {
    const stateWithData = state as ToolStateWithMetadata;
    const described = toolDescription(part.tool, stateWithData.input, stateWithData.metadata);
    if (described?.kind !== 'path') {
        return null;
    }
    return getRelativePath(described.value, currentDirectory);
};

type DescriptionTranslate = ReturnType<typeof useI18n>['t'];

/** Localized text for a tool description; paths are made relative to the project. */
const describeTool = (described: ToolDescription | null, currentDirectory: string, t: DescriptionTranslate, namespace?: string): string => {
    if (!described) return '';
    switch (described.kind) {
        case 'path':
            return getRelativePath(described.value, currentDirectory);
        case 'text':
            return described.value;
        case 'questions':
            return t('chat.toolPart.questionsAsked', { count: described.count });
        case 'files':
            return t('chat.toolPart.filesCount', { count: described.count });
        case 'tools': {
            // OpenCode's namespace tools fail their own call, so each call
            // that completed is named by its verb ("Listed worktrees") and a
            // failed one by the tool. OpenChamber's tools go by their row
            // names: Code Mode reports their call completed even when the
            // envelope says the action failed, so a verb would claim too much.
            // Under a row already titled by the script's one namespace, the
            // calls go by what they did inside it: an OpenChamber call by its
            // action, any other by its name within the namespace.
            const counts = new Map<string, number>();
            const add = (label: string, count: number) => counts.set(label, (counts.get(label) ?? 0) + count);
            for (const { name, count, completed, actions } of described.calls) {
                const opencode = opencodeToolVerb(name);
                if (opencode) add(completed ? t(opencode.key) : opencode.tool, count);
                else if (isOpenChamberTool(name) && namespace && actions.length > 0) actions.forEach(({ action, count: times }) => add(action, times));
                else if (isOpenChamberTool(name)) add(getToolMetadata(name).displayName, count);
                else add(namespace && name.toLowerCase().startsWith(`${namespace}.`) ? name.slice(namespace.length + 1) : name, count);
            }
            const named = [...counts]
                .map(([name, count]) => (count > 1 ? `${name} \u00d7${count}` : name))
                .join(', ');
            return described.overflow > 0
                ? `${named}, ${t('chat.toolPart.moreToolCalls', { count: described.overflow })}`
                : named;
        }
    }
};

/**
 * The row's title. `todowrite` takes the Work Status section's localized name,
 * since both show the same list side by side.
 */
export const toolDisplayName = (toolName: string, t: DescriptionTranslate): string => (
    isTodoWriteTool(toolName) ? t('chat.workStatus.section.tasks') : getToolMetadata(toolName).displayName
);

export const getToolDescription = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string, t: DescriptionTranslate, namespace?: string): string => {
    const stateWithData = state as ToolStateWithMetadata;
    return describeTool(toolDescription(part.tool, stateWithData.input, stateWithData.metadata), currentDirectory, t, namespace);
};

/**
 * What one of OpenChamber's own tools did, once it did it: "Remembered ·
 * Uses bun" rather than "memory.save · Uses bun". The tool's name stays the
 * row's title. A call still running, one that failed, or an action without a
 * verb keeps the action's own name.
 */
export const describeOpenChamberRow = (
    part: ToolPartType,
    input: ToolInput | undefined,
    output: string | undefined,
    translate: ReturnType<typeof useI18n>['t'],
): string | null => {
    if (part.state.status !== 'completed') return null;
    const summary = openChamberCallSummary(part.tool, input);
    // A history page leaves the result out until the row opens, and says
    // which action it answered instead.
    const envelope = parseOpenChamberEnvelope(output) ?? toolContentShellEnvelope(part);
    // A secret call's verb says how it ended; a history page keeps only the
    // action, so its row names the action until it opens.
    const run = secretRowView(envelope);
    if (summary && run) {
        const verb = translate(run.key, run.code === undefined ? undefined : { code: String(run.code) });
        return summary.detail ? `${verb} · ${summary.detail.slice(0, 120)}` : verb;
    }
    // The envelope names the action the server ran, a bare `link` included.
    const key = openChamberVerbKey(envelope?.action);
    if (!summary || !key || envelope?.ok !== true) return null;
    const verb = translate(key);
    return summary.detail ? `${verb} \u00b7 ${summary.detail.slice(0, 120)}` : verb;
};

/**
 * The same for a tool of OpenCode's `opencode` namespace, titled "OpenCode":
 * "Renamed the session · Voice models" once the call succeeded, the tool's
 * own name (`session_rename`) while it runs or after it failed. Success is the
 * call's status, which a history page keeps.
 */
export const describeOpencodeRow = (
    part: ToolPartType,
    detail: string,
    translate: ReturnType<typeof useI18n>['t'],
): string | null => {
    const verb = opencodeToolVerb(part.tool);
    if (!verb) return null;
    const action = opencodeCallSucceeded(part) ? translate(verb.key) : verb.tool;
    return detail ? `${action} \u00b7 ${detail.slice(0, 120)}` : action;
};
