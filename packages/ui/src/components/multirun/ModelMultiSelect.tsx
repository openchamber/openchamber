import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useI18n } from '@/lib/i18n';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';

/** Chip height class - shared between chips and add button */
const CHIP_HEIGHT_CLASS = 'h-7';

/** UI-only type with instanceId for React keys and duplicate tracking */
export interface ModelSelectionWithId {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: string;
  instanceId: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- Utility is tightly coupled with ModelMultiSelect
export const generateInstanceId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * Model selection chip with remove button.
 * Shows instance index (e.g., "(2)") when same model is selected multiple times.
 */
const ModelChip: React.FC<{
  model: ModelSelectionWithId;
  instanceIndex: number;
  totalSameModel: number;
  onRemove: () => void;
}> = ({ model, instanceIndex, totalSameModel, onRemove }) => {
  const displayName = model.displayName || `${model.providerID}/${model.modelID}`;
  const label = totalSameModel > 1 ? `${displayName} (${instanceIndex})` : displayName;

  return (
    <div className={cn('flex items-center gap-1.5 px-2 rounded-md bg-interactive-selection/20 border border-border/30', CHIP_HEIGHT_CLASS)}>
      <ProviderLogo providerId={model.providerID} className="h-3.5 w-3.5" />
      <span className="typography-meta font-medium truncate max-w-[140px]">
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground ml-0.5"
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

export interface ModelMultiSelectProps {
  selectedModels: ModelSelectionWithId[];
  onAdd: (model: ModelSelectionWithId) => void;
  onRemove: (index: number) => void;
  onUpdate?: (index: number, model: ModelSelectionWithId) => void;
  /** Minimum models required (shows validation hint) */
  minModels?: number;
  /** Label for the add button */
  addButtonLabel?: string;
  /** Whether to show the selected chips */
  showChips?: boolean;
  /** Maximum models allowed */
  maxModels?: number;
  /** Optional className for add model trigger button */
  addButtonClassName?: string;
  /** Direction for the model picker popup. Multi-run launcher opens upward near the footer. */
  dropdownSide?: 'top' | 'bottom';
  /** Optional className for the picker popup. */
  dropdownClassName?: string;
  /** Optional className for the trigger/dropdown positioning container. */
  containerClassName?: string;
  /** Optional trigger icon override. */
  triggerIcon?: React.ReactNode;
}

/**
 * Model selector for multi-run (allows selecting same model multiple times).
 */
export const ModelMultiSelect: React.FC<ModelMultiSelectProps> = ({
  selectedModels,
  onAdd,
  onRemove,
  onUpdate,
  minModels,
  addButtonLabel,
  showChips = true,
  maxModels,
  addButtonClassName,
  dropdownSide = 'top',
  dropdownClassName,
  containerClassName,
  triggerIcon,
}) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers) as ModelPickerProvider[];
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
  const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
  const { favoriteModelsList, recentModelsList } = useModelLists();
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const providerOrder = useUIStore((state) => state.providerOrder);
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const isSingleSelect = maxModels === 1;
  const canAddModel = maxModels === undefined || selectedModels.length < maxModels || isSingleSelect;

  // Count occurrences of each model for display purposes
  const modelCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of selectedModels) {
      const key = `${m.providerID}:${m.modelID}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [selectedModels]);

  // Get instance index for a specific model selection
  const getInstanceIndex = React.useCallback((model: ModelSelectionWithId): number => {
    const sameModels = selectedModels.filter(
      m => m.providerID === model.providerID && m.modelID === model.modelID
    );
    return sameModels.findIndex(m => m.instanceId === model.instanceId) + 1;
  }, [selectedModels]);

  // Calculate available height: multi-run opens upward inside a scroller; fusion opens downward and may extend past the dialog.
  React.useEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();

    if (dropdownSide === 'bottom') {
      const viewportHeight = window.visualViewport?.height ?? document.documentElement.clientHeight ?? window.innerHeight;
      const spaceBelow = viewportHeight - triggerRect.bottom - 16;
      // availableHeight is only the scrollable model list; reserve room for search + keyboard hint chrome.
      const listSpaceBelow = spaceBelow - 112;
      setAvailableHeight(Math.max(160, Math.min(320, listSpaceBelow)));
      return;
    }

    // Find the nearest dialog or overflow ancestor to constrain within
    let container: HTMLElement | null = triggerRef.current.parentElement;
    while (container) {
      if (container.getAttribute('role') === 'dialog' || container.hasAttribute('data-scroll-shadow')) {
        break;
      }
      const style = getComputedStyle(container);
      if (style.overflow === 'auto' || style.overflow === 'hidden' || style.overflowY === 'auto' || style.overflowY === 'hidden') {
        break;
      }
      container = container.parentElement;
    }

    const topBound = container ? container.getBoundingClientRect().top : 0;
    const spaceAbove = triggerRect.top - topBound - 16;
    // Cap: min 150, max 300
    setAvailableHeight(Math.max(150, Math.min(300, spaceAbove)));
  }, [dropdownSide, isOpen]);

  React.useEffect(() => {
    if (!canAddModel && isOpen) {
      setIsOpen(false);
      setSearchQuery('');
    }
  }, [canAddModel, isOpen]);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelectModel = React.useCallback((entry: ModelPickerEntry) => {
    const nextModel = {
      providerID: entry.providerID,
      modelID: entry.modelID,
      displayName: (entry.model.name as string) || entry.modelID,
      instanceId: generateInstanceId(),
    };
    if (isSingleSelect && selectedModels.length > 0 && onUpdate) {
      onUpdate(0, nextModel);
    } else {
      onAdd(nextModel);
    }
    if (isSingleSelect) {
      setIsOpen(false);
      setSearchQuery('');
    }
  }, [isSingleSelect, onAdd, onUpdate, selectedModels.length]);

  const labels = React.useMemo(() => ({
    searchPlaceholder: t('multirun.modelMultiSelect.search.placeholder'),
    noResults: t('multirun.modelMultiSelect.search.noResults'),
    favorites: t('multirun.modelMultiSelect.sections.favorites'),
    recent: t('multirun.modelMultiSelect.sections.recent'),
    keyboardHint: t('multirun.modelMultiSelect.keyboard.hint'),
    favorite: t('settings.agents.modelSelector.actions.favorite'),
    unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
    capabilities: t('chat.modelControls.capabilities'),
    capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
    capabilityReasoning: t('chat.modelControls.capability.reasoning'),
    input: t('chat.modelControls.input'),
    output: t('chat.modelControls.output'),
    costPerMillion: t('chat.modelControls.costPerMillion'),
  }), [t]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 items-center">
        {/* Add model button (dropdown trigger) */}
        <div className={cn('relative', containerClassName)} ref={dropdownRef}>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              CHIP_HEIGHT_CLASS,
              '!border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70',
              addButtonClassName,
            )}
            disabled={!canAddModel}
            onClick={() => {
              setIsOpen(!isOpen);
            }}
          >
            {triggerIcon ?? <Icon name="add" className="h-3.5 w-3.5 mr-1" />}
            {addButtonLabel ?? t('multirun.modelMultiSelect.actions.addModel')}
          </Button>

          {isOpen ? (
            <div
              className={cn(
                'absolute left-0 z-50 w-[min(420px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex flex-col overflow-hidden rounded-xl border border-border/50 shadow-lg',
                dropdownSide === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
                dropdownClassName,
              )}
              style={{
                background: 'linear-gradient(var(--surface-elevated),var(--surface-elevated)),linear-gradient(var(--surface-background),var(--surface-background))',
              }}
            >
              <ModelPickerList
                providers={providers}
                providerOrder={providerOrder}
                favoriteModels={favoriteModelsList}
                recentModels={recentModelsList}
                modelsMetadata={modelsMetadata}
                hiddenModels={hiddenModels}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                onSelect={handleSelectModel}
                labels={labels}
                selectionCount={(entry) => modelCounts.get(`${entry.providerID}:${entry.modelID}`) || 0}
                disabled={!canAddModel}
                maxHeightClassName="flex-1"
                maxHeightStyle={{ maxHeight: availableHeight ? `${availableHeight}px` : '300px' }}
                stickyHeaders
                tooltipsEnabled={isOpen}
                isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                onEscape={() => {
                  setIsOpen(false);
                  setSearchQuery('');
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Selected models */}
        {showChips && selectedModels.length > 0 && (
          <div className="flex flex-col gap-2 w-full">
            {selectedModels.map((model, index) => {
              const key = `${model.providerID}:${model.modelID}`;
              const totalSameModel = modelCounts.get(key) || 1;
              const instanceIndex = getInstanceIndex(model);

              const provider = providers.find((p) => p.id === model.providerID);
              const providerModel = provider?.models?.find((m: Record<string, unknown>) => (m as { id?: string }).id === model.modelID) as
                | { variants?: Record<string, unknown> }
                | undefined;
              const variantKeys = providerModel?.variants ? Object.keys(providerModel.variants) : [];
              const hasVariants = variantKeys.length > 0;

              const DEFAULT_VARIANT_VALUE = '__default__';
              const variantValue = model.variant ?? DEFAULT_VARIANT_VALUE;

              return (
                <div key={model.instanceId} className="flex items-center gap-2 min-w-0">
                  <ModelChip
                    model={model}
                    instanceIndex={instanceIndex}
                    totalSameModel={totalSameModel}
                    onRemove={() => onRemove(index)}
                  />

                  {hasVariants && (
                    <Select
                      value={variantValue}
                      onValueChange={(value) => {
                        if (!onUpdate) return;
                        const nextVariant = value === DEFAULT_VARIANT_VALUE ? undefined : value;
                        onUpdate(index, { ...model, variant: nextVariant });
                      }}
                    >
                      <SelectTrigger
                        size="chip"
                        className="px-2 gap-1.5 rounded-md !border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70 typography-meta font-medium text-foreground"
                      >
                        <Icon name="brain-ai-3"
                          className={cn(
                            'h-3.5 w-3.5 flex-shrink-0',
                            variantValue === DEFAULT_VARIANT_VALUE ? 'text-muted-foreground' : 'text-[color:var(--status-info)]'
                          )}
                        />
                        <SelectValue placeholder={t('multirun.modelMultiSelect.variant.placeholder')}>
                          {(value) => value === DEFAULT_VARIANT_VALUE
                            ? t('multirun.modelMultiSelect.variant.default')
                            : value}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent fitContent>
                        <SelectItem value={DEFAULT_VARIANT_VALUE} className="pr-2 [&>span:first-child]:hidden">
                          {t('multirun.modelMultiSelect.variant.default')}
                        </SelectItem>
                        {variantKeys.map((variant) => (
                          <SelectItem key={variant} value={variant} className="pr-2 [&>span:first-child]:hidden">
                            {variant}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Validation hint */}
      {minModels !== undefined && selectedModels.length < minModels && (
        <p className="typography-micro text-muted-foreground">
          {maxModels !== undefined
            ? t('multirun.modelMultiSelect.validation.minToMax', { min: minModels, max: maxModels })
            : t('multirun.modelMultiSelect.validation.minOnly', { min: minModels })}
        </p>
      )}
    </div>
  );
};
