import type React from 'react';

import type { ChatNavigationButtonAlignment } from '@/stores/useUIStore';

type ChatNavigationButtonPositionInput = {
    alignment: ChatNavigationButtonAlignment;
    isLeftSidebarOpen: boolean;
    isRightSidebarOpen: boolean;
    wideChatLayoutEnabled: boolean;
};

type ChatNavigationButtonPosition = {
    className?: string;
    style?: React.CSSProperties;
};

export const getChatNavigationButtonPosition = ({
    alignment,
    isLeftSidebarOpen,
    isRightSidebarOpen,
    wideChatLayoutEnabled,
}: ChatNavigationButtonPositionInput): ChatNavigationButtonPosition => {
    if (alignment === 'center') {
        return { className: 'left-1/2 -translate-x-1/2' };
    }

    const minPadding = alignment === 'left'
        ? (isLeftSidebarOpen ? '0.75rem' : '1.125rem')
        : (isRightSidebarOpen ? '0.75rem' : '1.125rem');
    const colWidth = wideChatLayoutEnabled ? '64rem' : '48rem';
    const offset = `max(${minPadding}, calc((100% - ${colWidth}) / 2 - 1.5rem))`;

    return alignment === 'left'
        ? { style: { left: offset } }
        : { style: { right: offset } };
};
