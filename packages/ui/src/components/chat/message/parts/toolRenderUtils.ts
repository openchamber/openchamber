import { shouldShowToolParamSummary as shouldShowToolParamSummaryFromMetadata } from '@/lib/toolHelpers';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const shouldShowToolParamSummary = (toolName: unknown): boolean => {
    return shouldShowToolParamSummaryFromMetadata(toolName);
};

export const formatToolParamSummaryValue = (value: unknown): string => {
    if (typeof value === 'string') {
        return value.length > 30 ? `${value.substring(0, 30)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        const serialized = JSON.stringify(value);
        return serialized.length > 30 ? `${serialized.substring(0, 30)}...` : serialized;
    }
    return String(value);
};
