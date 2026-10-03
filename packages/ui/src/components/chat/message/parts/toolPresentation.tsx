import React from 'react';
import { Icon } from "@/components/icon/Icon";
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { resolveGuestToolIcon } from '@/lib/guests/icon';
import type { GuestToolRule } from '@/lib/guests/tool-presentation';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

/**
 * Icon for a tool row, dialog header, or error fallback. An extension rule
 * with an icon wins: a package SVG drawn as a currentColor mask, or a
 * Remixicon the sprite knows; otherwise the built-in mapping runs on the
 * normalized name, and an unknown tool gets the generic wrench.
 */
export const getToolIcon = (toolName: string, presentation?: GuestToolRule | null) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const guestIcon = presentation
        ? resolveGuestToolIcon(presentation.guestId, presentation.icon, getRuntimeUrlResolver().authenticatedAsset)
        : null;
    if (guestIcon) {
        return <GuestIcon icon={guestIcon.icon} iconSrc={guestIcon.iconSrc} className={iconClass} />;
    }
    const tool = toolName.toLowerCase();

    if (tool === 'reasoning') {
        return <Icon name="brain-ai-3" className={iconClass} />;
    }
    if (tool === 'image-preview') {
        return <Icon name="file-image" className={iconClass} />;
    }
    if (tool === 'mermaid-preview') {
        return <Icon name="file-list-2" className={iconClass} />;
    }
    if (tool === 'edit' || tool === 'patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <Icon name="pencil" className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <Icon name="file-edit" className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <Icon name="file-text" className={iconClass} />;
    }
    if (tool === 'execute') {
        return <Icon name="braces" className={iconClass} />;
    }
    if (tool === 'shell' || tool === 'bash' || tool === 'cmd' || tool === 'terminal') {
        return <Icon name="terminal-box" className={iconClass} />;
    }
    if (tool === 'ls' || tool === 'dir' || tool === 'list_files') {
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
    if (tool === 'structuredoutput' || tool === 'structured_output') {
        return <Icon name="list-check-2" className={iconClass} />;
    }
    if (tool === 'skill') {
        return <Icon name="book" className={iconClass} />;
    }
    if (tool === 'subagent') {
        return <Icon name="ai-agent" className={iconClass} />;
    }
    if (tool === 'openchamber') {
        return <Icon name="openchamber" className={iconClass} />;
    }
    if (tool === 'linear' || tool.startsWith('linear_')) {
        return <Icon name="linear" className={iconClass} />;
    }
    if (tool === 'cloudflare' || tool.startsWith('cloudflare_') || tool === 'claudflare' || tool.startsWith('claudflare_')) {
        return <Icon name="cloudflare" className={iconClass} />;
    }
    if (tool === 'openchamber_web') {
        return <Icon name="global" className={iconClass} />;
    }
    if (tool === 'openchamber_notify') {
        return <Icon name="notification-3" className={iconClass} />;
    }
    if (tool === 'openchamber_memory') {
        return <Icon name="brain-4" className={iconClass} />;
    }
    if (tool === 'question') {
        return <Icon name="survey" className={iconClass} />;
    }
    if (tool === 'plan_enter') {
        return <Icon name="file-list-2" className={iconClass} />;
    }
    if (tool === 'plan_exit') {
        return <Icon name="task" className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <Icon name="git-branch" className={iconClass} />;
    }
    return <Icon name="tools" className={iconClass} />;
};
