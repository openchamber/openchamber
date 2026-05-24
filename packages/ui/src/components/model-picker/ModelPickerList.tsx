import React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';

export type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

export type ModelPickerProvider = {
  id: string;
  name?: string;
  models?: ProviderModel[];
};

export type ModelPickerEntry = {
  model: ProviderModel;
  providerID: string;
  modelID: string;
};

export type ModelPickerFavoriteEntry = ModelPickerEntry;

type HiddenModel = { providerID: string; modelID: string };

type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
});

const getModelDisplayName = (model: Record<string, unknown>) => {
  const name = model?.name || model?.id || '';
  const nameStr = String(name);
  if (nameStr.length > 40) return `${nameStr.substring(0, 37)}...`;
  return nameStr;
};

const formatModelContextTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const formatted = COMPACT_NUMBER_FORMATTER.format(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return CURRENCY_FORMATTER.format(value);
};

const hasTooltipMetadata = (metadata?: ModelMetadata) => {
  if (!metadata) return false;
  return Boolean(
    metadata.tool_call ||
    metadata.reasoning ||
    metadata.cost?.input !== undefined ||
    metadata.cost?.output !== undefined ||
    (metadata.modalities?.input?.length ?? 0) > 0 ||
    (metadata.modalities?.output?.length ?? 0) > 0,
  );
};

const ModelPickerRowTooltip: React.FC<{
  metadata?: ModelMetadata;
  active: boolean;
  labels: ModelPickerListProps['labels'];
  children: React.ReactElement;
}> = ({ metadata, active, labels, children }) => {
  const [delayedActive, setDelayedActive] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setDelayedActive(false);
      return;
    }
    const timeout = window.setTimeout(() => setDelayedActive(true), 450);
    return () => window.clearTimeout(timeout);
  }, [active]);

  if (!hasTooltipMetadata(metadata)) return children;

  const inputModalities = metadata?.modalities?.input ?? [];
  const outputModalities = metadata?.modalities?.output ?? [];
  const capabilities = [
    metadata?.tool_call ? labels.capabilityToolCalling : null,
    metadata?.reasoning ? labels.capabilityReasoning : null,
  ].filter(Boolean);

  return (
    <Tooltip delayDuration={0} open={active && delayedActive} onOpenChange={() => {}}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {active && delayedActive ? (
        <TooltipContent side="right" sideOffset={8} className="max-w-xs text-left transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100">
          <div className="flex flex-col gap-2 text-left text-xs">
            {capabilities.length > 0 ? (
              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="typography-meta font-medium">{labels.capabilities}</span>
                <span className="typography-meta text-foreground">{capabilities.join(', ')}</span>
              </div>
            ) : null}
            {inputModalities.length > 0 ? (
              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="typography-meta font-medium">{labels.input}</span>
                <span className="typography-meta text-foreground">{inputModalities.join(', ')}</span>
              </div>
            ) : null}
            {outputModalities.length > 0 ? (
              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="typography-meta font-medium">{labels.output}</span>
                <span className="typography-meta text-foreground">{outputModalities.join(', ')}</span>
              </div>
            ) : null}
            {(metadata?.cost?.input !== undefined || metadata?.cost?.output !== undefined) ? (
              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="typography-meta font-medium">{labels.costPerMillion}</span>
                <span className="typography-meta text-foreground">In {formatCost(metadata?.cost?.input)} · Out {formatCost(metadata?.cost?.output)}</span>
              </div>
            ) : null}
          </div>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
};

const createIndexSelectionStore = (): IndexSelectionStore => {
  let value = 0;
  const listeners = new Set<() => void>();
  const listenersByIndex = new Map<number, Set<() => void>>();
  const notify = (index: number) => {
    const listeners = listenersByIndex.get(index);
    if (!listeners) return;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeIndex: (index, listener) => {
      let listeners = listenersByIndex.get(index);
      if (!listeners) {
        listeners = new Set();
        listenersByIndex.set(index, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByIndex.delete(index);
      };
    },
    set: (nextValue) => {
      if (value === nextValue) return;
      const previousValue = value;
      value = nextValue;
      notify(previousValue);
      notify(nextValue);
      for (const listener of listeners) listener();
    },
  };
};

const ModelPickerRowHighlight: React.FC<{
  store: IndexSelectionStore;
  index: number;
  renderVersion?: number;
  children: (isHighlighted: boolean) => React.ReactNode;
}> = React.memo(({ store, index, children }) => {
  const [isHighlighted, setIsHighlighted] = React.useState(() => store.getSnapshot() === index);

  React.useEffect(() => {
    const sync = () => setIsHighlighted(store.getSnapshot() === index);
    sync();
    return store.subscribeIndex(index, sync);
  }, [index, store]);

  return <>{children(isHighlighted)}</>;
});

const ModelPickerFooter: React.FC<{
  store: IndexSelectionStore;
  flatModelList: ModelPickerEntry[];
  footerContent: ModelPickerListProps['footerContent'];
  fallback: React.ReactNode;
}> = ({ store, flatModelList, footerContent, fallback }) => {
  const [selectedIndex, setSelectedIndex] = React.useState(() => store.getSnapshot());

  React.useEffect(() => store.subscribe(() => setSelectedIndex(store.getSnapshot())), [store]);

  const activeEntry = flatModelList[selectedIndex];
  return <>{typeof footerContent === 'function' ? footerContent(activeEntry) : (footerContent ?? fallback)}</>;
};

type SortableFavoriteHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
  isDragging: boolean;
};

const SortableFavoriteModelRow: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableFavoriteHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </div>
  );
};

const STICKY_HEADER_OFFSET = 32;

const scrollIntoView = (container: HTMLElement | null, node: HTMLElement | null) => {
  if (!node) return;
  if (!container) {
    node.scrollIntoView({ block: 'nearest' });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const top = nodeRect.top - containerRect.top + container.scrollTop;
  const bottom = top + nodeRect.height;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + container.clientHeight;
  const viewTopWithHeader = viewTop + STICKY_HEADER_OFFSET;
  const target = top < viewTopWithHeader
    ? top - STICKY_HEADER_OFFSET
    : bottom > viewBottom
      ? bottom - container.clientHeight
      : viewTop;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.max(0, Math.min(target, max));
};

interface ModelPickerListProps {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerFavoriteEntry[];
  recentModels: ModelPickerFavoriteEntry[];
  modelsMetadata: Map<string, ModelMetadata>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: {
    searchPlaceholder: string;
    noResults: string;
    favorites: string;
    recent: string;
    keyboardHint: string;
    notSelected?: string;
    favorite?: string;
    unfavorite?: string;
    capabilities?: string;
    capabilityToolCalling?: string;
    capabilityReasoning?: string;
    input?: string;
    output?: string;
    costPerMillion?: string;
  };
  selectedModel?: { providerID: string; modelID: string } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  selectionCount?: (entry: ModelPickerEntry) => number;
  disabled?: boolean;
  maxHeightClassName?: string;
  maxHeightStyle?: React.CSSProperties;
  sectionHeaderClassName?: string;
  rowClassName?: string;
  stickyHeaders?: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
  isFavorite?: (entry: ModelPickerEntry) => boolean;
  onToggleFavorite?: (entry: ModelPickerEntry) => void;
  renderRowEnd?: (entry: ModelPickerEntry, state: { isHighlighted: boolean; isSelected: boolean }) => React.ReactNode;
  onActiveKeyDown?: (event: React.KeyboardEvent, entry: ModelPickerEntry | undefined) => void;
  onActiveEntryChange?: (entry: ModelPickerEntry | undefined) => void;
  onVariantKey?: (event: React.KeyboardEvent, entry: ModelPickerEntry) => boolean;
  onReorderFavorite?: (active: ModelPickerEntry, over: ModelPickerEntry) => void;
  reorderFavoriteAriaLabel?: string;
  reorderFavoriteTitle?: string;
  footerContent?: React.ReactNode | ((activeEntry: ModelPickerEntry | undefined) => React.ReactNode);
  renderVersion?: number;
  tooltipsEnabled?: boolean;
}

export const ModelPickerList: React.FC<ModelPickerListProps> = ({
  providers,
  favoriteModels,
  recentModels,
  modelsMetadata,
  searchQuery,
  onSearchQueryChange,
  onSelect,
  labels,
  selectedModel,
  hiddenModels = [],
  allowedProviderIds,
  includeNotSelected = false,
  onSelectNone,
  selectionCount,
  disabled = false,
  maxHeightClassName = 'max-h-[min(400px,calc(100dvh-12rem))] flex-1',
  maxHeightStyle,
  sectionHeaderClassName,
  rowClassName,
  stickyHeaders = true,
  autoFocus = true,
  onEscape,
  isFavorite,
  onToggleFavorite,
  renderRowEnd,
  onActiveKeyDown,
  onActiveEntryChange,
  onVariantKey,
  onReorderFavorite,
  reorderFavoriteAriaLabel,
  reorderFavoriteTitle,
  footerContent,
  renderVersion,
  tooltipsEnabled = true,
}) => {
  const selectionStoreRef = React.useRef<IndexSelectionStore | null>(null);
  if (!selectionStoreRef.current) selectionStoreRef.current = createIndexSelectionStore();
  const selectionStore = selectionStoreRef.current;
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const keyboardOwnsSelectionRef = React.useRef(false);
  const lastMousePositionRef = React.useRef<{ x: number; y: number } | null>(null);
  const [collapsedSections, setCollapsedSections] = React.useState<Set<string>>(() => new Set());
  const favoriteRowSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const allowedProviderSet = React.useMemo(() => {
    if (!allowedProviderIds || allowedProviderIds.length === 0) return null;
    return new Set(allowedProviderIds);
  }, [allowedProviderIds]);

  const providerById = React.useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const isHidden = React.useCallback((providerID: string, modelID: string) => {
    return hiddenModels.some((hidden) => hidden.providerID === providerID && hidden.modelID === modelID);
  }, [hiddenModels]);

  const matchesQuery = React.useCallback((modelName: string, providerName: string) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return modelName.toLowerCase().includes(query) || providerName.toLowerCase().includes(query);
  }, [searchQuery]);

  const filteredFavorites = React.useMemo(() => favoriteModels.filter(({ model, providerID, modelID }) => {
    if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
    if (isHidden(providerID, modelID)) return false;
    const providerName = providerById.get(providerID)?.name || providerID;
    return matchesQuery(getModelDisplayName(model), providerName);
  }), [allowedProviderSet, favoriteModels, isHidden, matchesQuery, providerById]);

  const filteredRecents = React.useMemo(() => recentModels.filter(({ model, providerID, modelID }) => {
    if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
    if (isHidden(providerID, modelID)) return false;
    const providerName = providerById.get(providerID)?.name || providerID;
    return matchesQuery(getModelDisplayName(model), providerName);
  }), [allowedProviderSet, isHidden, matchesQuery, providerById, recentModels]);

  const filteredProviders = React.useMemo(() => providers
    .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
    .map((provider) => {
      const models = Array.isArray(provider.models) ? provider.models : [];
      const filteredModels = models.filter((model) => {
        const modelID = typeof model.id === 'string' ? model.id : '';
        if (!modelID || isHidden(provider.id, modelID)) return false;
        return matchesQuery(getModelDisplayName(model), provider.name || provider.id);
      });
      return { ...provider, models: filteredModels };
    })
    .filter((provider) => provider.models.length > 0), [allowedProviderSet, isHidden, matchesQuery, providers]);

  const flatModelList = React.useMemo(() => {
    const items: ModelPickerEntry[] = [];
    if (!collapsedSections.has('favorites')) filteredFavorites.forEach((entry) => items.push(entry));
    if (!collapsedSections.has('recent')) filteredRecents.forEach((entry) => items.push(entry));
    filteredProviders.forEach((provider) => {
      if (collapsedSections.has(`provider:${provider.id}`)) return;
      provider.models.forEach((model) => items.push({ model, providerID: provider.id, modelID: model.id as string }));
    });
    return items;
  }, [collapsedSections, filteredFavorites, filteredProviders, filteredRecents]);

  const hasResults = flatModelList.length > 0;
  const favoriteSortingEnabled = Boolean(onReorderFavorite) && searchQuery.trim().length === 0 && filteredFavorites.length > 1;
  const favoriteLookup: Map<string, ModelPickerEntry> = React.useMemo(() => new Map(
    filteredFavorites.map((entry) => [`${entry.providerID}:${entry.modelID}`, entry] as const),
  ), [filteredFavorites]);

  React.useEffect(() => {
    selectionStore.set(0);
  }, [searchQuery, selectionStore]);

  const selectIndex = React.useCallback((index: number) => {
    selectionStore.set(index);
    onActiveEntryChange?.(flatModelList[index]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const moveSelection = React.useCallback((direction: 1 | -1) => {
    const total = flatModelList.length;
    if (total === 0) return;
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    const currentIndex = selectionStore.getSnapshot();
    const nextIndex = (currentIndex + direction + total) % total;
    selectionStore.set(nextIndex);
    onActiveEntryChange?.(flatModelList[nextIndex]);
    requestAnimationFrame(() => scrollIntoView(scrollRef.current, itemRefs.current[nextIndex]));
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  React.useEffect(() => {
    onActiveEntryChange?.(flatModelList[selectionStore.getSnapshot()]);
  }, [flatModelList, onActiveEntryChange, selectionStore]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    event.stopPropagation();
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && onVariantKey?.(event, selected)) return;
    }
    onActiveKeyDown?.(event, flatModelList[selectionStore.getSnapshot()]);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = flatModelList[selectionStore.getSnapshot()];
      if (selected && !disabled) onSelect(selected);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    }
  }, [disabled, flatModelList, moveSelection, onActiveKeyDown, onEscape, onSelect, onVariantKey, selectionStore]);

  const headerClassName = cn(
    'typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30',
    stickyHeaders && 'sticky top-0 z-10 [background:linear-gradient(var(--surface-elevated),var(--surface-elevated)),linear-gradient(var(--surface-background),var(--surface-background))]',
    sectionHeaderClassName,
  );

  let currentFlatIndex = 0;

  const renderRow = (entry: ModelPickerEntry, keyPrefix: string, showProviderLogo: boolean, rowIndex: number, dragHandleProps?: SortableFavoriteHandleProps | null) => {
    const metadata = mergeModelMetadataWithLiveModel(entry.providerID, entry.model, modelsMetadata.get(`${entry.providerID}/${entry.modelID}`));
    const contextTokens = formatModelContextTokens(metadata?.limit?.context);
    const count = selectionCount?.(entry) ?? 0;
    const isSelected = selectedModel?.providerID === entry.providerID && selectedModel.modelID === entry.modelID;
    const favorite = isFavorite?.(entry) ?? false;

    const handleMouseActivity = (event: React.MouseEvent) => {
      const nextPosition = { x: event.clientX, y: event.clientY };
      const previousPosition = lastMousePositionRef.current;
      const pointerMoved = !previousPosition || previousPosition.x !== nextPosition.x || previousPosition.y !== nextPosition.y;
      lastMousePositionRef.current = nextPosition;

      if (keyboardOwnsSelectionRef.current && !previousPosition) return;
      if (keyboardOwnsSelectionRef.current && !pointerMoved) return;
      if (keyboardOwnsSelectionRef.current && pointerMoved) keyboardOwnsSelectionRef.current = false;
      selectIndex(rowIndex);
    };

    return (
      <ModelPickerRowHighlight key={`${keyPrefix}-${entry.providerID}-${entry.modelID}`} store={selectionStore} index={rowIndex} renderVersion={renderVersion}>
        {(isHighlighted) => {
          const rowElement = (
            <div
              ref={(el) => { itemRefs.current[rowIndex] = el; }}
              role="option"
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              tabIndex={-1}
              onClick={() => { if (!disabled) onSelect(entry); }}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(entry);
                }
              }}
              onMouseEnter={handleMouseActivity}
              onMouseMove={handleMouseActivity}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer',
                !disabled && (isHighlighted ? 'bg-interactive-selection' : 'hover:bg-interactive-hover/50'),
                disabled && 'cursor-not-allowed opacity-60',
                rowClassName,
              )}
            >
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                {dragHandleProps ? (
                  <button type="button" ref={dragHandleProps.setActivatorNodeRef} {...dragHandleProps.attributes} {...dragHandleProps.listeners} disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} className="model-favorite-drag-handle flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none" aria-label={reorderFavoriteAriaLabel} title={reorderFavoriteTitle}>
                    <Icon name="draggable" className="size-3.5" />
                  </button>
                ) : null}
                {showProviderLogo ? <ProviderLogo providerId={entry.providerID} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <span className="font-medium truncate">{getModelDisplayName(entry.model)}</span>
                {contextTokens ? <span className="typography-micro text-muted-foreground flex-shrink-0">{contextTokens}</span> : null}
              </div>
              {count > 0 ? <span className="typography-micro text-muted-foreground flex-shrink-0">x{count}</span> : null}
              {renderRowEnd?.(entry, { isHighlighted, isSelected })}
              {isSelected ? <Icon name="check" className="h-4 w-4 text-primary flex-shrink-0" /> : null}
              {onToggleFavorite ? (
                <button type="button" disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFavorite(entry); }} className={cn('model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80 flex-shrink-0 disabled:pointer-events-none', favorite ? 'text-primary' : 'text-muted-foreground')} aria-label={favorite ? labels.unfavorite : labels.favorite} title={favorite ? labels.unfavorite : labels.favorite}>
                  <Icon name={favorite ? 'star-fill' : 'star'} className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );

          return <ModelPickerRowTooltip metadata={metadata} active={tooltipsEnabled && isHighlighted} labels={labels}>{rowElement}</ModelPickerRowTooltip>;
        }}
      </ModelPickerRowHighlight>
    );
  };

  const handleFavoriteDragEnd = (event: DragEndEvent) => {
    if (!onReorderFavorite) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeFavorite = favoriteLookup.get(String(active.id));
    const overFavorite = favoriteLookup.get(String(over.id));
    if (!activeFavorite || !overFavorite) return;

    onReorderFavorite(activeFavorite, overFavorite);
  };

  const isSectionCollapsed = (key: string) => collapsedSections.has(key);
  const toggleSectionCollapsed = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderSectionHeader = (key: string, icon: React.ReactNode, label: React.ReactNode) => {
    const collapsed = isSectionCollapsed(key);
    return (
      <button
        type="button"
        className={cn(headerClassName, 'w-full text-left cursor-pointer')}
        onClick={() => toggleSectionCollapsed(key)}
        aria-expanded={!collapsed}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="px-2 py-1 border-b border-border/40">
        <div className="relative">
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={labels.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 rounded-none bg-transparent pl-8 pr-0 typography-meta ring-0 hover:[&:not(:focus)]:bg-transparent focus:ring-0 focus-visible:ring-0"
            autoFocus={autoFocus}
          />
        </div>
      </div>

      <ScrollableOverlay ref={scrollRef} outerClassName={maxHeightClassName} className="overlay-scrollbar-target--no-gutter" style={maxHeightStyle}>
        <div className="p-1">
          {includeNotSelected ? (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover/50"
                onClick={onSelectNone}
              >
                <Icon name="close" className="h-3.5 w-3.5" />
                <span>{labels.notSelected}</span>
                {!selectedModel ? <Icon name="check" className="h-4 w-4 text-primary ml-auto" /> : null}
              </button>
              <div className="h-px bg-border/40 my-1" />
            </>
          ) : null}

          {!hasResults ? (
            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">{labels.noResults}</div>
          ) : null}

          {filteredFavorites.length > 0 ? (
            <div>
              {renderSectionHeader('favorites', <Icon name="star-fill" className="h-4 w-4 text-primary" />, labels.favorites)}
              {!isSectionCollapsed('favorites') && (favoriteSortingEnabled ? (
                <DndContext sensors={favoriteRowSensors} collisionDetection={closestCenter} onDragEnd={handleFavoriteDragEnd}>
                  <SortableContext items={filteredFavorites.map((entry) => `${entry.providerID}:${entry.modelID}`)} strategy={verticalListSortingStrategy}>
                    {filteredFavorites.map((entry) => {
                      const rowIndex = currentFlatIndex++;
                      return (
                        <SortableFavoriteModelRow key={`fav-sortable-${entry.providerID}-${entry.modelID}`} id={`${entry.providerID}:${entry.modelID}`} disabled={disabled}>
                          {(dragHandleProps) => renderRow(entry, 'fav', true, rowIndex, dragHandleProps)}
                        </SortableFavoriteModelRow>
                      );
                    })}
                  </SortableContext>
                </DndContext>
              ) : filteredFavorites.map((entry) => renderRow(entry, 'fav', true, currentFlatIndex++)))}
            </div>
          ) : null}

          {filteredRecents.length > 0 ? (
            <div>
              {filteredFavorites.length > 0 ? <div className="h-px bg-border/40 my-1" /> : null}
              {renderSectionHeader('recent', <Icon name="time" className="h-4 w-4" />, labels.recent)}
              {!isSectionCollapsed('recent') ? filteredRecents.map((entry) => renderRow(entry, 'recent', true, currentFlatIndex++)) : null}
            </div>
          ) : null}

          {(filteredFavorites.length > 0 || filteredRecents.length > 0) && filteredProviders.length > 0 ? <div className="h-px bg-border/40 my-1" /> : null}

          {filteredProviders.map((provider, providerIndex) => (
            <div key={provider.id}>
              {providerIndex > 0 ? <div className="h-px bg-border/40 my-1" /> : null}
              {renderSectionHeader(`provider:${provider.id}`, <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />, provider.name || provider.id)}
              {!isSectionCollapsed(`provider:${provider.id}`)
                ? provider.models.map((model) => renderRow({ model, providerID: provider.id, modelID: model.id as string }, 'provider', false, currentFlatIndex++))
                : null}
            </div>
          ))}
        </div>
      </ScrollableOverlay>

      <div className="px-3 pt-1 pb-1.5 border-t border-border/40 typography-micro text-muted-foreground">
        <ModelPickerFooter store={selectionStore} flatModelList={flatModelList} footerContent={footerContent} fallback={labels.keyboardHint} />
      </div>
    </>
  );
};
