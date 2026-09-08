import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getModelDisplayName } from './mobileControlsUtils';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
    model?: { providerId: string; modelId: string } | null;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className, model }) => {
    const { t } = useI18n();
    const currentModelId = useConfigStore((state) => model === undefined ? state.currentModelId : model?.modelId);
    const currentProviderId = useConfigStore((state) => model === undefined ? state.currentProviderId : model?.providerId);
    const providers = useConfigStore((state) => state.providers);
    const currentProvider = providers.find((provider) => provider.id === currentProviderId);
    const modelLabel = getModelDisplayName(currentProvider, currentModelId, t('chat.modelControls.selectModel'));

    return (
        <button
            type="button"
            onClick={onOpenModel}
            // Same guard as PermissionAutoAcceptButton/MobileAgentButton: block
            // the focus transfer so the tap doesn't dismiss the keyboard. With
            // interactive-widget=resizes-content (Android), the keyboard-close
            // relayout moves this button mid-tap and the click never lands.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
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
