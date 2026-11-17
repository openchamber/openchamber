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
    // external: #2265 Cap tool payloads before JSON parsing, highlighting and DOM allocation.
    const capped = capToolOutputText(output);
    if (isShellTool(part.tool)) {
        return capped;
    }

    return formatEditOutput(capped, part.tool, metadata);
};
