import React from 'react';
import {
    RiAiAgentLine,
    RiBookLine,
    RiFileEditLine,
    RiFileList2Line,
    RiFileSearchLine,
    RiFileTextLine,
    RiFolder6Line,
    RiGitBranchLine,
    RiGlobalLine,
    RiListCheck2,
    RiListCheck3,
    RiMenuSearchLine,
    RiPencilLine,
    RiSurveyLine,
    RiTaskLine,
    RiTerminalBoxLine,
    RiToolsLine,
} from '@remixicon/react';

export const getToolIcon = (toolName: string, category?: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const tool = toolName.toLowerCase();

    if (category === 'shell') return <RiTerminalBoxLine className={iconClass} />;
    if (category === 'edit') return <RiPencilLine className={iconClass} />;
    if (category === 'search') return <RiMenuSearchLine className={iconClass} />;
    if (category === 'fetch') return <RiGlobalLine className={iconClass} />;
    if (category === 'task') return <RiAiAgentLine className={iconClass} />;

    if (tool === 'edit' || tool === 'multiedit' || tool === 'apply_patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <RiPencilLine className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <RiFileEditLine className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <RiFileTextLine className={iconClass} />;
    }
    if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal') {
        return <RiTerminalBoxLine className={iconClass} />;
    }
    if (tool === 'list' || tool === 'ls' || tool === 'dir' || tool === 'list_files') {
        return <RiFolder6Line className={iconClass} />;
    }
    if (tool === 'search' || tool === 'grep' || tool === 'find' || tool === 'ripgrep') {
        return <RiMenuSearchLine className={iconClass} />;
    }
    if (tool === 'glob') {
        return <RiFileSearchLine className={iconClass} />;
    }
    if (tool === 'fetch' || tool === 'curl' || tool === 'wget' || tool === 'webfetch') {
        return <RiGlobalLine className={iconClass} />;
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
        return <RiGlobalLine className={iconClass} />;
    }
    if (tool === 'todowrite' || tool === 'todoread') {
        return <RiListCheck3 className={iconClass} />;
    }
    if (tool === 'structuredoutput' || tool === 'structured_output') {
        return <RiListCheck2 className={iconClass} />;
    }
    if (tool === 'skill') {
        return <RiBookLine className={iconClass} />;
    }
    if (tool === 'task') {
        return <RiAiAgentLine className={iconClass} />;
    }
    if (tool === 'question') {
        return <RiSurveyLine className={iconClass} />;
    }
    if (tool === 'plan_enter') {
        return <RiFileList2Line className={iconClass} />;
    }
    if (tool === 'plan_exit') {
        return <RiTaskLine className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <RiGitBranchLine className={iconClass} />;
    }
    return <RiToolsLine className={iconClass} />;
};
