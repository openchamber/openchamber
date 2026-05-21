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
    const normalizedToolName = normalizeToolName(toolName);
    if (!normalizedToolName) {
        return false;
    }

    return !STANDALONE_TOOL_NAMES.has(normalizedToolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};
