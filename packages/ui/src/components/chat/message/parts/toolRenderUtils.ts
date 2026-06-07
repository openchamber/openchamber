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
