import type { ToolPart as ToolPartType } from '@/lib/opencode/model';
import { formatEditOutput, detectLanguageFromOutput, capToolOutputText } from '../../toolRenderers';
import { isShellTool } from '@/lib/opencode/tools';

export const getToolOutputLanguage = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> | undefined,
): string => {
    if (isShellTool(part.tool)) {
        return 'bash';
    }

    return detectLanguageFromOutput(formatEditOutput(output, part.tool, metadata), part.tool, input);
};

export const getToolOutputText = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
): string => {
    // Cap oversized payloads before JSON.parse / syntax highlighting / DOM work
    // so a single huge tool output can't trigger a V8 Zone-allocation OOM that
    // hard-crashes the renderer (issue #2265).
    const capped = capToolOutputText(output);
    if (isShellTool(part.tool)) {
        return capped;
    }

    return formatEditOutput(capped, part.tool, metadata);
};
