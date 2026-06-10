import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { getChatNavigationButtonPosition } from '../chatNavigationButtonPosition';

interface ScrollToTopButtonProps {
    visible: boolean;
    onClick: () => void;
    disabled?: boolean;
    onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
}

const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({ visible, onClick, disabled = false, onWheelCapture }) => {
    const { t } = useI18n();
    const label = t('chat.jumpToPreviousMessage.aria');
    const alignment = useUIStore((state) => state.chatNavigationButtonAlignment);
    const isLeftSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
    const position = getChatNavigationButtonPosition({ alignment, isLeftSidebarOpen, isRightSidebarOpen, wideChatLayoutEnabled });

    return (
        <div
            className={cn(
                'absolute top-3 z-20 transition-all duration-150',
                position.className,
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-2 scale-95 pointer-events-none',
            )}
            style={position.style}
            onWheelCapture={onWheelCapture}
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
                <TooltipContent side="bottom" align="center" sideOffset={4}>{label}</TooltipContent>
            </Tooltip>
        </div>
    );
};

export default React.memo(ScrollToTopButton);
