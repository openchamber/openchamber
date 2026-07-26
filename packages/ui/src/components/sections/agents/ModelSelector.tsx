import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { useModelLists } from '@/hooks/useModelLists';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string) => void;
    className?: string;
    allowedProviderIds?: string[];
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    onChange,
    className,
    allowedProviderIds,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const providers = useConfigStore((state) => state.providers) as ModelPickerProvider[];
    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
    const isMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');

    const closePicker = React.useCallback(() => {
        setIsMobilePanelOpen(false);
        setIsDropdownOpen(false);
        setSearchQuery('');
    }, []);

    const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
        onChange(entry.providerID, entry.modelID);
        addRecentModel(entry.providerID, entry.modelID);
        closePicker();
    }, [addRecentModel, closePicker, onChange]);

    const handleSelectNone = React.useCallback(() => {
        onChange('', '');
        closePicker();
    }, [closePicker, onChange]);

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [placeholder, t]);

    const selectedModel = providerId && modelId ? { providerID: providerId, modelID: modelId } : null;
    // Show the model's display name (as in the picker list), not the raw provider/model id.
    const triggerLabel = React.useMemo(() => {
        if (!providerId || !modelId) {
            return placeholder || t('settings.agents.modelSelector.notSelected');
        }
        const provider = providers.find((entry) => entry.id === providerId);
        const model = provider?.models?.find((entry) => entry.id === modelId);
        return (typeof model?.name === 'string' && model.name.trim()) || modelId;
    }, [modelId, placeholder, providerId, providers, t]);

    const picker = (
        <ModelPickerList
            providers={providers}
            providerOrder={providerOrder}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            modelsMetadata={modelsMetadata}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={handleSelect}
            labels={labels}
            selectedModel={selectedModel}
            hiddenModels={hiddenModels}
            allowedProviderIds={allowedProviderIds}
            includeNotSelected
            onSelectNone={handleSelectNone}
            onEscape={closePicker}
            tooltipsEnabled={tooltipsEnabled && (isActuallyMobile ? isMobilePanelOpen : isDropdownOpen)}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
        />
    );

    if (isActuallyMobile) {
        return (
            <>
                <button
                    type="button"
                    onClick={isReady ? () => setIsMobilePanelOpen(true) : undefined}
                    disabled={!isReady}
                    className={cn(
                        dropdownTriggerVariants(),
                        'w-full',
                        className,
                    )}
                >
                    <div className="flex min-w-0 items-center gap-2">
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : providerId ? (
                            <ProviderLogo providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="pencil-ai" className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isReady ? <span className="typography-meta font-medium text-foreground truncate">{triggerLabel}</span> : null}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </button>
                <MobileOverlayPanel
                    open={isMobilePanelOpen}
                    onClose={closePicker}
                    title={t('settings.agents.modelSelector.title')}
                >
                    {picker}
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <DropdownMenu open={isReady && isDropdownOpen} onOpenChange={isReady ? setIsDropdownOpen : undefined}>
            <DropdownMenuTrigger asChild>
                <div className={cn(
                    dropdownTriggerVariants({ size: 'sm' }),
                    'min-w-0 w-fit',
                    !isReady && 'opacity-60 cursor-not-allowed',
                    className,
                )}>
                    {!isReady ? (
                        <>
                            <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                            <span className="typography-ui-label font-normal whitespace-nowrap text-muted-foreground">
                                {isUnavailable ? t('common.unavailable') : t('common.loading')}
                            </span>
                        </>
                    ) : (
                        <>
                            {providerId ? <ProviderLogo providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" /> : <Icon name="pencil-ai" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-left font-normal text-foreground">{triggerLabel}</span>
                        </>
                    )}
                    <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col" align="start" portalToBody={dropdownPortalToBody}>
                {picker}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
