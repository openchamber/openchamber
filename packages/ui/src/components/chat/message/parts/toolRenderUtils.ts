const EXPANDABLE_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'bash', 'shell', 'cmd', 'terminal',
    'write', 'create', 'file_write',
    'question', 'task', 'lsp',
    'skill_mcp', 'skill-mcp', 'skill',
    'grep', 'glob', 'list', 'search', 'find', 'ripgrep',
    'todowrite', 'todoread',
    'websearch_web_search_exa', 'webfetch', 'codesearch',
    'lsp_diagnostics', 'lsp_goto_definition', 'lsp_find_references', 'lsp_symbols', 'lsp_rename', 'lsp_prepare_rename',
    'session_list', 'session_read', 'session_info', 'session_search',
    'background_output', 'monitor_output', 'background_cancel',
    'hashline_edit', 'structuredoutput', 'structured_output',
    'plan_enter', 'plan_exit',
    'ast_grep_search', 'ast_grep_find', 'ast_grep_replace', 'ast_grep_replace_all', 'ast_grep_list', 'ast_grep_list_all', 'look_at',
    'call_omo_agent'
]);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const SEARCH_TOOL_NAMES = new Set<string>(['grep', 'search', 'find', 'ripgrep', 'glob']);

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
    return EXPANDABLE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
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
