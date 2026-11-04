import type { Part } from '@/lib/opencode/model';
import { OPENCODE_TOOLS, isFileChangeTool, isNavigationTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
export const isStaticTool = (toolName: ToolName): boolean => isNavigationTool(toolName);

/**
 * Ids of the up-to-`limit` most recent file-change tool calls (write, edit,
 * patch) in `parts`, in chronological order. Feeds auto-expanding those rows
 * during a streaming turn; `limit` of Infinity takes all of them.
 */
export const collectFileChangeToolIds = (parts: readonly Part[], limit: number): string[] => {
    if (limit <= 0) return [];
    const ids: string[] = [];
    for (let i = parts.length - 1; i >= 0 && ids.length < limit; i -= 1) {
        const part = parts[i];
        if (part.type !== 'tool') continue;
        if (!isFileChangeTool(part.tool)) continue;
        ids.unshift(part.id);
    }
    return ids;
};
