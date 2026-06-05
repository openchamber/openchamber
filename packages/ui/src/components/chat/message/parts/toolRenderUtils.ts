const EXPANDABLE_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'bash', 'shell', 'cmd', 'terminal',
    'write', 'create', 'file_write',
    'question', 'task',
    'execute', 'list_servers', 'list_groups', 'upload_file', 'download_file',
    'web_search', 'web_fetch', 'resolve', 'query',
]);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const SEARCH_TOOL_NAMES = new Set<string>(['grep', 'search', 'find', 'ripgrep', 'glob']);

/**
 * Tools that already have custom visual rendering in ToolPart.tsx
 * (diff views, command display, file previews, etc).
 * These do NOT need an inline parameter summary.
 */
const TOOLS_WITH_CUSTOM_RENDERING = new Set<string>([
    'apply_patch', 'edit', 'multiedit',
    'write', 'create', 'file_write',
    'read',
    'bash', 'shell', 'cmd', 'terminal',
    'question', 'task',
    'todowrite', 'todoread',
    'grep', 'search', 'find', 'ripgrep', 'glob',
]);

/**
 * Returns true when a tool has NO custom visual rendering and should
 * show its parameters inline in the title row.
 * This covers MCP tools, plugin tools, and any tool without dedicated UI.
 */
export const shouldShowToolParamSummary = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return false;
    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (TOOLS_WITH_CUSTOM_RENDERING.has(withoutIndex)) return false;
    const normalized = normalizeToolName(trimmed);
    if (TOOLS_WITH_CUSTOM_RENDERING.has(normalized)) return false;
    return true;
};

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');

    if (withoutIndex.includes('_')) {
        const lastUnderscoreIndex = withoutIndex.lastIndexOf('_');
        return withoutIndex.slice(lastUnderscoreIndex + 1);
    }

    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }

    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return false;
    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (EXPANDABLE_TOOL_NAMES.has(withoutIndex)) return true;
    if (!TOOLS_WITH_CUSTOM_RENDERING.has(withoutIndex) && !STANDALONE_TOOL_NAMES.has(withoutIndex)) {
        return true;
    }
    return EXPANDABLE_TOOL_NAMES.has(normalizeToolName(trimmed));
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    const trimmed = toolName.trim().toLowerCase().replace(/:\d+$/, '');
    if (STANDALONE_TOOL_NAMES.has(trimmed)) return true;
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(trimmed));
};

export const isStaticTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return !isExpandableTool(toolName) && !isStandaloneTool(toolName);
};

export const getStaticGroupToolName = (toolName: string): string => {
    const normalized = normalizeToolName(toolName);
    if (SEARCH_TOOL_NAMES.has(normalized)) {
        return 'grep';
    }
    return normalized;
};
