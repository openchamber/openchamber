import React from 'react';
import { Icon } from "@/components/icon/Icon";

export const getToolIcon = (toolName: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const tool = toolName.toLowerCase();

    if (tool === 'edit' || tool === 'multiedit' || tool === 'apply_patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <Icon name="pencil" className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <Icon name="file-edit" className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <Icon name="file-text" className={iconClass} />;
    }
    if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal') {
        return <Icon name="terminal-box" className={iconClass} />;
    }
    if (tool === 'list' || tool === 'ls' || tool === 'dir' || tool === 'list_files') {
        return <Icon name="folder-6" className={iconClass} />;
    }
    if (tool === 'search' || tool === 'grep' || tool === 'find' || tool === 'ripgrep') {
        return <Icon name="menu-search" className={iconClass} />;
    }
    if (tool === 'glob') {
        return <Icon name="file-search" className={iconClass} />;
    }
    if (tool === 'fetch' || tool === 'curl' || tool === 'wget' || tool === 'webfetch') {
        return <Icon name="global" className={iconClass} />;
    }
    if (
        tool === 'web-search' ||
        tool === 'websearch' ||
        tool === 'search_web' ||
        tool === 'codesearch' ||
        tool === 'google' ||
        tool === 'bing' ||
        tool === 'duckduckgo' ||
        tool === 'perplexity'
    ) {
        return <Icon name="global" className={iconClass} />;
    }
    if (tool === 'todowrite' || tool === 'todoread') {
        return <Icon name="list-check-3" className={iconClass} />;
    }
    if (tool === 'structuredoutput' || tool === 'structured_output') {
        return <Icon name="list-check-2" className={iconClass} />;
    }
    if (tool === 'skill') {
        return <Icon name="book" className={iconClass} />;
    }
    if (tool === 'task') {
        return <Icon name="ai-agent" className={iconClass} />;
    }
    if (tool === 'question') {
        return <Icon name="survey" className={iconClass} />;
    }
    if (tool === 'lsp') {
        return <Icon name="scan-2" className={iconClass} />;
    }
    if (tool === 'lsp_diagnostics') {
        return <Icon name="error-warning" className={iconClass} />;
    }
    if (tool === 'lsp_goto_definition' || tool === 'lsp_find_references') {
        return <Icon name="search-eye" className={iconClass} />;
    }
    if (tool === 'lsp_symbols') {
        return <Icon name="list-unordered" className={iconClass} />;
    }
    if (tool === 'lsp_rename' || tool === 'lsp_prepare_rename') {
        return <Icon name="pencil" className={iconClass} />;
    }
    if (tool === 'session_list' || tool === 'session_read' || tool === 'session_info' || tool === 'session_search') {
        return <Icon name="history" className={iconClass} />;
    }
    if (tool === 'background_output' || tool === 'background_cancel') {
        return <Icon name="time" className={iconClass} />;
    }
    if (tool === 'monitor_output' || tool === 'monitor_start' || tool === 'monitor_stop' || tool === 'monitor_list') {
        return <Icon name="eye" className={iconClass} />;
    }
    if (tool === 'hashline_edit') {
        return <Icon name="pencil" className={iconClass} />;
    }
    if (tool === 'interactive_bash') {
        return <Icon name="terminal-window" className={iconClass} />;
    }
    if (tool === 'plan_enter') {
        return <Icon name="file-list-2" className={iconClass} />;
    }
    if (tool === 'plan_exit') {
        return <Icon name="task" className={iconClass} />;
    }
    if (tool === 'look_at' || tool === 'look-at') {
        return <Icon name="eye" className={iconClass} />;
    }
    if (tool === 'skill_mcp' || tool === 'skill-mcp') {
        return <Icon name="plug" className={iconClass} />;
    }
    if (tool === 'call_omo_agent' || tool === 'call-omo-agent') {
        return <Icon name="ai-agent" className={iconClass} />;
    }
    if (tool === 'delegate_task' || tool === 'delegate-task') {
        return <Icon name="share-2" className={iconClass} />;
    }
    if (tool === 'session_manager' || tool === 'session-manager') {
        return <Icon name="history" className={iconClass} />;
    }
    if (tool === 'slashcommand' || tool === 'slash_command') {
        return <Icon name="command" className={iconClass} />;
    }
    if (tool === 'background_task' || tool === 'background-task') {
        return <Icon name="time" className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <Icon name="git-branch" className={iconClass} />;
    }
    if (tool.startsWith('codegraph_')) {
        return <Icon name="node-tree" className={iconClass} />;
    }
    if (tool.startsWith('ast_grep_')) {
        return <Icon name="search" className={iconClass} />;
    }
    if (tool.startsWith('grep_app_')) {
        return <Icon name="scan-2" className={iconClass} />;
    }
    if (tool.startsWith('context7_')) {
        return <Icon name="file-text" className={iconClass} />;
    }
    return <Icon name="tools" className={iconClass} />;
};
