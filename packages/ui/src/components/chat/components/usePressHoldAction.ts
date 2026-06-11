import React from 'react';

const HOLD_ACTION_DELAY_MS = 900;

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
    const onClickRef = React.useRef(onClick);
    const onHoldRef = React.useRef(onHold);
    const [isShaking, setIsShaking] = React.useState(false);

    React.useEffect(() => {
        onClickRef.current = onClick;
    }, [onClick]);

    React.useEffect(() => {
        onHoldRef.current = onHold;
    }, [onHold]);

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
                onHoldRef.current();
            }, 300);
        }, HOLD_ACTION_DELAY_MS);
    }, [clearHoldTimer, disabled]);

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
        onClickRef.current();
    }, [clearHoldTimer, disabled]);

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

export const useNavigationButtonTooltip = ({ enabled = true }: { enabled?: boolean } = {}) => {
    const [open, setOpen] = React.useState(false);
    const [isHeld, setIsHeld] = React.useState(false);
    const [isLongHover, setIsLongHover] = React.useState(false);
    const hoverTimerRef = React.useRef<number | null>(null);
    const holdHoverTimerRef = React.useRef<number | null>(null);

    const clearHoverTimer = React.useCallback(() => {
        if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    const dismissTooltip = React.useCallback(() => {
        clearHoverTimer();
        setOpen(false);
        setIsLongHover(false);
    }, [clearHoverTimer]);

    const dismissDefaultTooltip = React.useCallback(() => {
        clearHoverTimer();
        setOpen(false);
    }, [clearHoverTimer]);

    const handlePointerEnter = React.useCallback(() => {
        if (!enabled) {
            return;
        }
        setIsLongHover(false);
        clearHoverTimer();
        hoverTimerRef.current = window.setTimeout(() => {
            setIsLongHover(true);
        }, 1750);
    }, [clearHoverTimer, enabled]);

    const handlePointerLeave = React.useCallback(() => {
        dismissTooltip();
        setIsHeld(false);
    }, [dismissTooltip]);

    const handlePointerDown = React.useCallback(() => {
        if (!enabled) {
            return;
        }

        if (isLongHover) {
            dismissDefaultTooltip();
        } else {
            dismissTooltip();
        }
        setIsHeld(true);
    }, [dismissDefaultTooltip, dismissTooltip, enabled, isLongHover]);

    const handlePointerUp = React.useCallback(() => {
        dismissTooltip();
        setIsHeld(false);
    }, [dismissTooltip]);

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        if (!nextOpen) {
            setOpen(false);
            return;
        }

        if (!enabled || isHeld) {
            return;
        }

        setOpen(true);
    }, [enabled, isHeld]);

    React.useEffect(() => {
        if (isHeld) {
            holdHoverTimerRef.current = window.setTimeout(() => {
                setIsLongHover(true);
            }, 500);
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
            dismissTooltip();
            setIsHeld(false);
        };

        window.addEventListener('pointerup', handleGlobalPointerUp);
        window.addEventListener('pointercancel', handleGlobalPointerUp);

        return () => {
            window.removeEventListener('pointerup', handleGlobalPointerUp);
            window.removeEventListener('pointercancel', handleGlobalPointerUp);
        };
    }, [dismissTooltip, isHeld]);

    React.useEffect(() => {
        if (enabled) {
            return;
        }

        dismissTooltip();
        setIsHeld(false);
    }, [dismissTooltip, enabled]);

    React.useEffect(() => {
        return () => {
            clearHoverTimer();
        };
    }, [clearHoverTimer]);

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
