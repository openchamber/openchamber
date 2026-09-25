import { OPENCODE_TOOLS, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.skill]);

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: ToolName): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};
