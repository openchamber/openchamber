import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { getChatNavigationButtonPosition } from '../chatNavigationButtonPosition';
import { usePressHoldAction } from './usePressHoldAction';

interface ScrollToTopButtonProps {
    visible: boolean;
    onClick: () => void;
    onHold: () => void;
    isLoadingHistory?: boolean;
    disabled?: boolean;
    onWheelCapture?: React.WheelEventHandler<HTMLDivElement>;
}

const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({ visible, onClick, onHold, isLoadingHistory = false, disabled = false, onWheelCapture }) => {
    const { t } = useI18n();
    const label = t('chat.jumpToPreviousMessage.aria');
    const alignment = useUIStore((state) => state.chatNavigationButtonAlignment);
    const isLeftSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
    const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
    const position = getChatNavigationButtonPosition({ alignment, isLeftSidebarOpen, isRightSidebarOpen, wideChatLayoutEnabled });
    const { isShaking, pressHoldProps } = usePressHoldAction({ disabled, onClick, onHold });

    const [open, setOpen] = React.useState(false);
    const [isHeld, setIsHeld] = React.useState(false);
    const [isLongHover, setIsLongHover] = React.useState(false);
    const hoverTimerRef = React.useRef<number | null>(null);
    const holdHoverTimerRef = React.useRef<number | null>(null);
    const [dotCount, setDotCount] = React.useState(0);

    const handlePointerEnter = React.useCallback(() => {
        setIsLongHover(false);
        if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
        }
        hoverTimerRef.current = window.setTimeout(() => {
            setIsLongHover(true);
        }, 1500);
    }, []);

    const handlePointerLeave = React.useCallback(() => {
        if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    const handlePointerDown = React.useCallback(() => {
        setIsHeld(true);
    }, []);

    const handlePointerUp = React.useCallback(() => {
        setIsHeld(false);
    }, []);

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        setOpen(nextOpen);
    }, []);

    React.useEffect(() => {
        if (isHeld) {
            holdHoverTimerRef.current = window.setTimeout(() => {
                setIsLongHover(true);
            }, 250);
        } else {
            if (holdHoverTimerRef.current !== null) {
                window.clearTimeout(holdHoverTimerRef.current);
                holdHoverTimerRef.current = null;
            }
        }
        return () => {
            if (holdHoverTimerRef.current !== null) {
                window.clearTimeout(holdHoverTimerRef.current);
            }
        };
    }, [isHeld]);

    React.useEffect(() => {
        if (!isLoadingHistory) {
            setDotCount(0);
            return;
        }

        const interval = window.setInterval(() => {
            setDotCount((prev) => (prev + 1) % 4);
        }, 500);

        return () => window.clearInterval(interval);
    }, [isLoadingHistory]);

    React.useEffect(() => {
        if (!isHeld) return;

        const handleGlobalPointerUp = () => {
            setIsHeld(false);
        };

        window.addEventListener('pointerup', handleGlobalPointerUp);
        window.addEventListener('pointercancel', handleGlobalPointerUp);

        return () => {
            window.removeEventListener('pointerup', handleGlobalPointerUp);
            window.removeEventListener('pointercancel', handleGlobalPointerUp);
        };
    }, [isHeld]);

    React.useEffect(() => {
        return () => {
            if (hoverTimerRef.current !== null) {
                window.clearTimeout(hoverTimerRef.current);
            }
        };
    }, []);

    const currentLabel = isLoadingHistory
        ? "Loading session history" + ".".repeat(dotCount)
        : isLongHover
        ? t('chat.jumpToPreviousMessage.hold')
        : label;

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
            <Tooltip open={open || isHeld || isLoadingHistory} onOpenChange={handleOpenChange}>
                <TooltipTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        {...pressHoldProps}
                        aria-disabled={disabled}
                        data-chat-navigation-button="true"
                        data-interactive={!disabled}
                        className={cn(
                            "size-8 rounded-full [corner-shape:round] p-0 shadow-none bg-background/95 hover:bg-interactive-hover",
                            disabled && "opacity-50",
                            isShaking && "animate-button-shake"
                        )}
                        aria-label={currentLabel}
                    >
                        <Icon name="arrow-down" className="h-4 w-4 rotate-180" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center" sideOffset={4}>
                    <span key={isLoadingHistory ? 'loading' : isLongHover ? 'hold' : 'default'} className="inline-block animate-tooltip-fade-in">
                        {currentLabel}
                    </span>
                </TooltipContent>
            </Tooltip>
        </div>
    );
};

export default React.memo(ScrollToTopButton);
