import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { TOOL_ROW_DESCRIPTION_CLASS } from '../message/parts/toolRow/toolRowStyles';

export const FoldLine: React.FC<{
    icon: IconName;
    failed?: boolean;
    open: boolean;
    controls?: string;
    onToggle: () => void;
    children: React.ReactNode;
}> = ({ icon, failed = false, open, controls, onToggle, children }) => {
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!open) dispatchRowExpand(event.currentTarget);
        onToggle();
    };
    return (
        <div className="chat-message-column">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={controls}
                onClick={handleClick}
                className={cn('group/fold flex w-full min-w-0 items-center gap-1.5 rounded-xl py-1.5 sm:py-1 ps-px pe-2 text-start focus-visible:outline-none', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-description)' }}
            >
                <span className={cn('relative size-3.5 shrink-0', failed && 'text-[var(--status-error)]')} style={failed ? undefined : { color: 'var(--tools-icon)' }}>
                    {!open ? <Icon name={icon} className="absolute inset-0 size-3.5 group-hover/fold:opacity-0 group-focus-visible/fold:opacity-0" /> : null}
                    <Icon
                        name={open ? 'arrow-down-s' : 'arrow-right-s'}
                        className={cn('absolute inset-0 size-3.5', !open && 'opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100')}
                    />
                </span>
                {children}
            </button>
        </div>
    );
};
