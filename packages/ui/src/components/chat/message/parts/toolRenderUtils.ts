import { OPENCODE_TOOLS, isNavigationTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

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
