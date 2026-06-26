const EXPANDABLE_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'bash', 'shell', 'cmd', 'terminal',
    'write', 'create', 'file_write',
    'question', 'task', 'lsp',
    'skill_mcp', 'skill-mcp', 'skill',
    'grep', 'glob', 'list', 'search', 'find', 'ripgrep',
    'todowrite', 'todoread',
    'websearch_web_search_exa', 'webfetch', 'codesearch', 'monitor_output', 
    'hashline_edit', 'structuredoutput', 'structured_output',
    'plan_enter', 'plan_exit',
    'look_at', 'call_omo_agent'
]);

const EXPANDABLE_TOOL_PATTERNS = [
    /^codegraph_/,
    /^ast_grep_/,
    /^lsp_/,
    /^session_/,
    /^background_/,
    /^plan_/,
    /^grep_app_/,
    /^context7_/
];

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
    const normalized = normalizeToolName(toolName);
    return EXPANDABLE_TOOL_NAMES.has(normalized) || 
           EXPANDABLE_TOOL_PATTERNS.some(pattern => pattern.test(normalized));
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return !isExpandableTool(toolName) && !isStandaloneTool(toolName);
};
