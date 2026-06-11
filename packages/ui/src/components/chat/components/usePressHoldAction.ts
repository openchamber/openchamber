import React from 'react';

const HOLD_ACTION_DELAY_MS = 750;

export const usePressHoldAction = ({
    disabled,
    onClick,
    onHold,
}: {
    disabled: boolean;
    onClick: () => void;
    onHold: () => void;
}) => {
    const holdTimerRef = React.useRef<number | null>(null);
    const holdTriggeredRef = React.useRef(false);
    const [isShaking, setIsShaking] = React.useState(false);

    const clearHoldTimer = React.useCallback(() => {
        if (holdTimerRef.current === null || typeof window === 'undefined') {
            return;
        }
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
    }, []);

    const handlePointerDown = React.useCallback(() => {
        if (disabled || typeof window === 'undefined') {
            return;
        }

        clearHoldTimer();
        holdTriggeredRef.current = false;
        holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            holdTriggeredRef.current = true;
            setIsShaking(true);

            // Wait 300ms for the shake animation to complete before calling onHold
            window.setTimeout(() => {
                setIsShaking(false);
                onHold();
            }, 300);
        }, HOLD_ACTION_DELAY_MS);
    }, [clearHoldTimer, disabled, onHold]);

    const handlePointerEnd = React.useCallback(() => {
        clearHoldTimer();
    }, [clearHoldTimer]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        clearHoldTimer();
        if (disabled) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (holdTriggeredRef.current) {
            holdTriggeredRef.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        onClick();
    }, [clearHoldTimer, disabled, onClick]);

    React.useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

    return {
        isShaking,
        pressHoldProps: {
            onBlur: handlePointerEnd,
            onClick: handleClick,
            onPointerCancel: handlePointerEnd,
            onPointerDown: handlePointerDown,
            onPointerLeave: handlePointerEnd,
            onPointerUp: handlePointerEnd,
        },
    };
};

export const useNavigationButtonTooltip = () => {
    const [open, setOpen] = React.useState(false);
    const [isHeld, setIsHeld] = React.useState(false);
    const [isLongHover, setIsLongHover] = React.useState(false);
    const hoverTimerRef = React.useRef<number | null>(null);
    const holdHoverTimerRef = React.useRef<number | null>(null);

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
            }, 350);
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

    return {
        open,
        isHeld,
        isLongHover,
        handlePointerEnter,
        handlePointerLeave,
        handlePointerDown,
        handlePointerUp,
        handleOpenChange,
    };
};
