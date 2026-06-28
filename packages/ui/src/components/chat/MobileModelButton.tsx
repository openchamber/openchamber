import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getModelDisplayName } from './mobileControlsUtils';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className }) => {
    const { t } = useI18n();
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const currentProvider = getCurrentProvider();
    const modelLabel = getModelDisplayName(currentProvider, currentModelId, t('chat.modelControls.selectModel'));

    return (
        <button
            type="button"
            onClick={onOpenModel}
            className={cn(
                'inline-flex min-w-0 items-stretch',
                'rounded-lg',
                'typography-micro font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                className
            )}
            style={{ height: '26px', maxHeight: '26px', minHeight: '26px' }}
            title={modelLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center gap-1">
                {currentProviderId ? (
                    <ProviderLogo providerId={currentProviderId} className="size-4 flex-shrink-0" />
                ) : null}
                <span className="truncate">{modelLabel}</span>
            </span>
        </button>
    );
};
