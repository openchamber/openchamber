import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { getChatNavigationButtonPosition } from '../chatNavigationButtonPosition';
import { useNavigationButtonTooltip, usePressHoldAction } from './usePressHoldAction';
import { BusyDots } from '../message/parts/BusyDots';

interface ScrollToTopButtonProps {
    visible: boolean;
    onClick: () => void;
    onHold: () => void;
    isLoadingHistory?: boolean;
    disabled?: boolean;
    activeWhileBusy?: boolean;
    subduedWhileOtherBusy?: boolean;
    onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
}

const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({ visible, onClick, onHold, isLoadingHistory = false, disabled = false, activeWhileBusy = false, subduedWhileOtherBusy = false, onWheelCapture }) => {
    const { t } = useI18n();
    const label = t('chat.jumpToPreviousMessage.aria');
    const alignment = useUIStore((state) => state.chatNavigationButtonAlignment);
    const isLeftSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
    const position = getChatNavigationButtonPosition({ alignment, isLeftSidebarOpen, isRightSidebarOpen, wideChatLayoutEnabled });
    const { isShaking, pressHoldProps } = usePressHoldAction({ disabled, onClick, onHold });
    const interactionTooltipEnabled = !disabled;
    const {
        open,
        isHeld,
        isLongHover,
        handlePointerEnter,
        handlePointerLeave,
        handlePointerDown,
        handlePointerUp,
        handleOpenChange,
    } = useNavigationButtonTooltip({ enabled: interactionTooltipEnabled, isShaking });

    const currentLabel = isLoadingHistory
        ? t('chat.loadAllHistory.aria')
        : (isLongHover || isShaking)
        ? t('chat.jumpToPreviousMessage.hold')
        : label;
    const tooltipOpen = isLoadingHistory || (interactionTooltipEnabled && (open || isLongHover || isShaking));

    return (
        <div
            className={cn(
                'absolute top-3 z-20 transition-all duration-150',
                position.className,
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-2 scale-95 pointer-events-none',
            )}
            style={position.style}
            onWheelCapture={onWheelCapture}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            <Tooltip delayDuration={300} open={tooltipOpen} onOpenChange={handleOpenChange}>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        {...pressHoldProps}
                        aria-disabled={disabled}
                        data-chat-navigation-button="true"
                        data-interactive={!disabled}
                        className={cn(
                            "size-8 rounded-full [corner-shape:round] p-0 shadow-none bg-background/95 text-muted-foreground opacity-75 hover:bg-interactive-hover hover:text-foreground hover:opacity-90",
                            (isHeld || isLoadingHistory || activeWhileBusy) && "bg-interactive-hover text-foreground opacity-100",
                            subduedWhileOtherBusy && "bg-background/95 text-muted-foreground opacity-75 hover:bg-background/95 hover:text-muted-foreground hover:opacity-75",
                            disabled && !(isHeld || isLoadingHistory || activeWhileBusy || subduedWhileOtherBusy) && "opacity-50",
                            isShaking && "animate-button-shake"
                        )}
                        aria-label={currentLabel}
                    >
                        <Icon name="arrow-down" className="h-4 w-4 rotate-180" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center" sideOffset={4}>
                    <span key={isLoadingHistory ? 'loading' : (isLongHover || isShaking) ? 'hold' : 'default'} className="inline-flex items-center animate-tooltip-fade-in">
                        <span>{currentLabel}</span>
                        {isLoadingHistory ? <BusyDots /> : null}
                    </span>
                </TooltipContent>
            </Tooltip>
        </div>
    );
};

export default React.memo(ScrollToTopButton);
