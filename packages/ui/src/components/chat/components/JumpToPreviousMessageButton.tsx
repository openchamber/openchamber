import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

interface JumpToPreviousMessageButtonProps {
    visible: boolean;
    onClick: () => void;
    disabled?: boolean;
}

const JumpToPreviousMessageButton: React.FC<JumpToPreviousMessageButtonProps> = ({ visible, onClick, disabled = false }) => {
    const { t } = useI18n();
    const label = t('chat.jumpToPreviousMessage.aria');
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);

    const minPadding = isRightSidebarOpen ? '0.75rem' : '1.125rem';
    const colWidth = wideChatLayoutEnabled ? '64rem' : '48rem';

    // The message column is centered, so the distance from its right edge to the screen edge is (100% - colWidth) / 2.
    // We want the button to sit on the right side of where the text appears (pushed further right by an offset of 1.5rem),
    // but no closer to the edge than minPadding if the window shrinks.
    const rightStyle = `max(${minPadding}, calc((100% - ${colWidth}) / 2 - 1.5rem))`;

    return (
        <div
            className={cn(
                'absolute top-3 z-20 transition-all duration-150',
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-2 scale-95 pointer-events-none',
            )}
            style={{ right: rightStyle }}
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onClick}
                        disabled={disabled}
                        className="size-8 rounded-full [corner-shape:round] p-0 shadow-none bg-background/95 hover:bg-interactive-hover"
                        aria-label={label}
                    >
                        <Icon name="arrow-down" className="h-4 w-4 rotate-180" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center" sideOffset={8}>{label}</TooltipContent>
            </Tooltip>
        </div>
    );
};

export default React.memo(JumpToPreviousMessageButton);
