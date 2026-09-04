import type { ToolState } from '@opencode-ai/sdk/v2';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

// OpenCode built-ins keep their dedicated path, command, and status rendering.
// Custom, MCP, and OpenChamber plugin tools may provide a useful per-call title.
const OPENCODE_BUILT_IN_TOOL_NAMES = new Set<string>([
    'read',
    'write',
    'edit',
    'multiedit',
    'apply_patch',
    'bash',
    'grep',
    'glob',
    'list',
    'task',
    'webfetch',
    'websearch',
    'codesearch',
    'todowrite',
    'todoread',
    'skill',
    'question',
    'lsp',
    'plan_enter',
    'plan_exit',
    'structuredoutput',
    'create',
    'file_write',
]);

const isOpenCodeBuiltInTool = (toolName: string): boolean => {
    const normalized = toolName.trim().toLowerCase().replace(/:\d+$/, '');
    return !normalized.includes('.') && OPENCODE_BUILT_IN_TOOL_NAMES.has(normalized);
};

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

const getAuthoritativeToolTitle = (state: ToolState): string | null => {
    if (state.status !== 'running' && state.status !== 'completed') {
        return null;
    }

    const trimmedTitle = state.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : null;
};

export const getToolHeaderTitle = (toolName: string, state: ToolState, displayName: string): string => {
    return isOpenCodeBuiltInTool(toolName)
        ? displayName
        : getAuthoritativeToolTitle(state) ?? displayName;
};

export const getToolSecondaryText = (toolName: string, value: string | undefined, state: ToolState): string | null => {
    if (!value || value.trim().length === 0) return null;
    if (isOpenCodeBuiltInTool(toolName)) return value;

    const title = getAuthoritativeToolTitle(state);
    return title && value.trim() === title ? null : value;
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

export const getToolDescriptionFallback = (
    toolName: unknown,
    description: unknown,
    input: Record<string, unknown> | undefined,
): string => {
    if (typeof description === 'string' && description.trim().length > 0) {
        return description;
    }

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};
