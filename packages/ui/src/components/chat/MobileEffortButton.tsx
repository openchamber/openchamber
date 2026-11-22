import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { isAutoModel } from '@/lib/routing/autoModel';
import { swallowGestureClick } from '@/lib/swallowGestureClick';
import { formatEffortLabel, getEffortToneClass } from './mobileControlsUtils';

interface MobileEffortButtonProps {
    onCycleThinking: () => void;
    onOpenThinking: () => void;
    className?: string;
}

const LONG_PRESS_MS = 500;

export const MobileEffortButton: React.FC<MobileEffortButtonProps> = ({ onCycleThinking, onOpenThinking, className }) => {
    const { t } = useI18n();
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const hasVariants = useConfigStore((state) => state.getCurrentModelVariants().length > 0);
    const effectiveVariant = useConfigStore((state) => state.currentVariant);
    const variantSelection = useConfigStore((state) => state.currentVariantSelection);
    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressedRef = React.useRef(false);
    const clearLongPress = () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
    };
    React.useEffect(() => clearLongPress, []);

    if (isAutoModel(currentProviderId, currentModelId) || !hasVariants) return null;

    const variant = variantSelection.override === null ? undefined : variantSelection.override ?? effectiveVariant;
    const label = variant ? formatEffortLabel(variant) : t('chat.modelControls.default');

    return (
        <button
            type="button"
            onPointerDown={(event) => {
                if (event.pointerType === 'touch') event.preventDefault();
                longPressedRef.current = false;
                clearLongPress();
                longPressTimerRef.current = setTimeout(() => {
                    longPressedRef.current = true;
                    swallowGestureClick();
                    onOpenThinking();
                }, LONG_PRESS_MS);
            }}
            onPointerUp={() => {
                const pressing = longPressTimerRef.current !== null;
                clearLongPress();
                if (pressing && !longPressedRef.current) onCycleThinking();
            }}
            onPointerLeave={clearLongPress}
            onPointerCancel={clearLongPress}
            onContextMenu={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            aria-label={`${t('chat.modelControls.thinking')}: ${label}`}
            className={cn(
                '-my-[5px] inline-flex h-9 min-w-0 flex-shrink-0 items-center gap-1 rounded-lg px-1.5',
                'typography-micro font-medium lowercase text-muted-foreground',
                'select-none touch-none focus:outline-none hover:bg-[var(--interactive-hover)]',
                className,
            )}
        >
            <span aria-hidden="true" className="opacity-60">/</span>
            <span className={cn('whitespace-nowrap', getEffortToneClass(variant))}>{label}</span>
        </button>
    );
};
