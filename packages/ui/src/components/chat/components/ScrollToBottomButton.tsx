import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { getChatNavigationButtonPosition } from '../chatNavigationButtonPosition';

interface ScrollToBottomButtonProps {
    visible: boolean;
    onClick: () => void;
    onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, onClick, onWheelCapture }) => {
    const { t } = useI18n();
    const alignment = useUIStore((state) => state.chatNavigationButtonAlignment);
    const isLeftSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
    const position = getChatNavigationButtonPosition({ alignment, isLeftSidebarOpen, isRightSidebarOpen, wideChatLayoutEnabled });

    return (
        <div
            className={cn(
                'absolute bottom-full mb-2 transition-all duration-150',
                position.className,
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-2 scale-95 pointer-events-none',
            )}
            style={position.style}
            onWheelCapture={onWheelCapture}
        >
            <Button
                variant="outline"
                size="sm"
                onClick={onClick}
                className="size-8 rounded-full [corner-shape:round] p-0 shadow-none bg-background/95 hover:bg-interactive-hover"
                aria-label={t('chat.scrollToBottom.aria')}
            >
                <Icon name="arrow-down" className="h-4 w-4" />
            </Button>
        </div>
    );
};

export default React.memo(ScrollToBottomButton);
