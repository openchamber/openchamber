import {
    getStaticToolGroupName,
    getToolRenderMode,
    isToolActivityGroupBoundary,
    shouldShowToolParamSummary as shouldShowToolParamSummaryFromMetadata,
} from '@/lib/toolHelpers';

/**
 * Tool rendering policy is owned by toolHelpers metadata. Unknown MCP/plugin
 * tools default to expandable rendering with an inline parameter summary.
 */
export const shouldShowToolParamSummary = (toolName: unknown): boolean => {
    return shouldShowToolParamSummaryFromMetadata(toolName);
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return getToolRenderMode(toolName) === 'expandable';
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return isToolActivityGroupBoundary(toolName) || getToolRenderMode(toolName) === 'standalone';
};

export const isStaticTool = (toolName: unknown): boolean => {
    return getToolRenderMode(toolName) === 'static';
};

export const getStaticGroupToolName = (toolName: string): string => {
    return getStaticToolGroupName(toolName);
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
