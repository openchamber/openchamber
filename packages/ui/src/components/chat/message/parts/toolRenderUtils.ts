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

const getAuthoritativeToolTitle = (state: unknown): string | null => {
    const title = typeof state === 'object' && state !== null && 'title' in state
        ? state.title
        : undefined;
    if (typeof title !== 'string') return null;
    const trimmedTitle = title.trim();
    return trimmedTitle.length > 0 ? trimmedTitle : null;
};

export const getToolHeaderTitle = (state: unknown, displayName: string): string => {
    return getAuthoritativeToolTitle(state) ?? displayName;
};

export const getToolSecondaryText = (value: unknown, state: unknown): string | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const normalizedValue = value.trim().replace(/\\/g, '/');
    const normalizedTitle = getAuthoritativeToolTitle(state)?.replace(/\\/g, '/');
    return normalizedValue === normalizedTitle ? null : value;
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
