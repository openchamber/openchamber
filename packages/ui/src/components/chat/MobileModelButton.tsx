import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getModelDisplayName } from './mobileControlsUtils';
import { useI18n } from '@/lib/i18n';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className }) => {
    const { t } = useI18n();
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const currentProvider = getCurrentProvider();
    const modelLabel = getModelDisplayName(currentProvider, currentModelId, t('chat.modelControls.selectModel'));

    return (
        <button
            type="button"
            onClick={onOpenModel}
            className={cn(
                'inline-flex min-w-0 items-center justify-center',
                'rounded-lg border border-border/50 px-1.5',
                'typography-micro font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                className
            )}
            style={{ height: '26px', maxHeight: '26px', minHeight: '26px' }}
            title={modelLabel}
        >
            <span className="min-w-0 max-w-full overflow-x-auto whitespace-nowrap scrollbar-hidden">
                {modelLabel}
            </span>
        </button>
    );
};

export default MobileModelButton;
