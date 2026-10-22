import { getToolMetadata } from '@/lib/toolHelpers';
import { toolDescription, toolDescriptionText } from '@/lib/opencode/tools';
import type { Part } from '@/lib/opencode/model';

type LiveToolStatus = {
    label: string;
    description: string;
};

/**
 * The newest call still running, for the folded Activity header. Completed
 * calls are not "currently running", so the header goes back to plain Activity
 * while the model thinks between steps.
 */
export const latestRunningTool = (parts: readonly Part[]): LiveToolStatus | null => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part?.type !== 'tool') continue;
        const status = part.state.status;
        if (status !== 'running' && status !== 'pending') continue;
        return {
            label: getToolMetadata(part.tool).displayName,
            description: toolDescriptionText(toolDescription(
                part.tool,
                part.state.input,
                status === 'running' ? part.state.metadata : undefined,
            )),
        };
    }
    return null;
};
