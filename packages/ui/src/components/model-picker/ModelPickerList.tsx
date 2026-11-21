import React from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { defaultRangeExtractor, observeElementRect, useVirtualizer, type Range, type VirtualItem } from '@tanstack/react-virtual';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Input } from '@/components/ui/input';
import { PICKER_SEARCH_INPUT_CLASS } from '@/components/ui/MobileSheetList';
import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent } from '@/components/ui/tooltip';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { formatCompactNumber } from '@/lib/numberFormat';
import { cn } from '@/lib/utils';
import { swallowGestureClick } from '@/lib/swallowGestureClick';
import { useConfigStore } from '@/stores/useConfigStore';
import { useModelPickerSectionsStore } from '@/stores/useModelPickerSectionsStore';
import type { ModelMetadata } from '@/types';

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

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

type ModelPickerFavoriteEntry = ModelPickerEntry;

type HiddenModel = { providerID: string; modelID: string };

type IndexSelectionStore = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  subscribeIndex: (index: number, listener: () => void) => () => void;
  set: (value: number) => void;
};

const formatUsdCurrency = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
}).format(value);

const getModelDisplayName = (model: Record<string, unknown>) => {
  return getSharedModelDisplayName(model, undefined, { maxLength: 40 });
};

const formatModelContextTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (value === 0) return '0';
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatUsdCurrency(value);
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

const ROW_TOOLTIP_OFFSET = 20;

const ROW_TOOLTIP_ROOM = 320 + ROW_TOOLTIP_OFFSET;

const pickRowTooltipSide = (row: Element | null): 'right' | 'left' | null => {
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  if (window.innerWidth - rect.right >= ROW_TOOLTIP_ROOM) return 'right';
  if (rect.left >= ROW_TOOLTIP_ROOM) return 'left';
  return null;
};

export const ModelPickerCardBody: React.FC<{
  metadata?: ModelMetadata;
  providerName: string | null;
  labels: ModelPickerListProps['labels'];
}> = ({ metadata, providerName, labels }) => {
  const inputModalities = metadata?.modalities?.input ?? [];
  const outputModalities = metadata?.modalities?.output ?? [];
  const capabilities = [
    metadata?.tool_call ? labels.capabilityToolCalling : null,
    metadata?.reasoning ? labels.capabilityReasoning : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 text-start text-xs">
      {providerName ? (
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="typography-meta font-medium">{labels.provider}</span>
          <span className="typography-meta text-foreground">{providerName}</span>
        </div>
      ) : null}
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
  );
};

const ModelPickerRowCard: React.FC<{
  store: IndexSelectionStore;
  navigation: readonly NavigationItem[];
  itemRefs: React.RefObject<(HTMLDivElement | null)[]>;
  active: boolean;
  layoutVersion: string;
  describe: (entry: ModelPickerEntry) => { metadata?: ModelMetadata; providerName: string | null };
  labels: ModelPickerListProps['labels'];
}> = ({ store, navigation, itemRefs, active, layoutVersion, describe, labels }) => {
  const index = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const entry = entryOf(navigation[index]);
  const [placement, setPlacement] = React.useState<{ anchor: HTMLElement; side: 'right' | 'left' } | null>(null);

  React.useEffect(() => {
    setPlacement(null);
    if (!active || !entry) return;
    const timeout = window.setTimeout(() => {
      const anchor = itemRefs.current[index];
      const side = pickRowTooltipSide(anchor ?? null);
      if (anchor && side) setPlacement({ anchor, side });
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [active, entry, index, itemRefs]);

  React.useLayoutEffect(() => {
    setPlacement((current) => {
      if (!current || current.anchor.isConnected) return current;
      const anchor = itemRefs.current[index];
      return anchor ? { ...current, anchor } : null;
    });
  }, [index, itemRefs, layoutVersion]);

  if (!entry || !placement || !placement.anchor.isConnected) return null;
  const { metadata, providerName } = describe(entry);
  if (!providerName && !hasTooltipMetadata(metadata)) return null;

  return (
    <Tooltip open onOpenChange={() => {}}>
      <TooltipContent surface="card" anchor={placement.anchor} side={placement.side} align="start" sideOffset={ROW_TOOLTIP_OFFSET} className="max-w-xs text-start transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100">
        <ModelPickerCardBody metadata={metadata} providerName={providerName} labels={labels} />
      </TooltipContent>
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

const LEADING_ACTION_SLOT = 'leading-action';
type NavigationItem = ModelPickerEntry | typeof LEADING_ACTION_SLOT;

const entryOf = (item: NavigationItem | undefined): ModelPickerEntry | undefined => (
  item === LEADING_ACTION_SLOT ? undefined : item
);

const ModelPickerFooter: React.FC<{
  store: IndexSelectionStore;
  navigationList: NavigationItem[];
  footerContent: ModelPickerListProps['footerContent'];
  fallback: React.ReactNode;
}> = ({ store, navigationList, footerContent, fallback }) => {
  const selectedIndex = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  const activeEntry = entryOf(navigationList[selectedIndex]);
  return <>{typeof footerContent === 'function' ? footerContent(activeEntry) : (footerContent ?? fallback)}</>;
};

type SortableShell = {
  setNodeRef: (element: HTMLElement | null) => void;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>['listeners'];
  style: React.CSSProperties;
  isDragging: boolean;
};

const SortableRow: React.FC<{
  id: string;
  disabled: boolean;
  children: (shell: SortableShell) => React.ReactNode;
}> = ({ id, disabled, children }) => {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return <>{children({
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    style: { transform: DndCSS.Translate.toString(transform), transition },
    isDragging,
  })}</>;
};

type SectionKind = 'leading' | 'fav' | 'recent' | 'provider';

type PickerRow =
  | { kind: 'not-selected'; key: string; group: null }
  | { kind: 'no-results'; key: string; group: null }
  | { kind: 'action'; key: string; group: null; navIndex: number }
  | { kind: 'header'; key: string; group: RowGroup; sectionKey: string; spaced: boolean; collapsed: boolean; providerId?: string }
  | { kind: 'model'; key: string; group: RowGroup | null; section: SectionKind; entry: ModelPickerEntry; navIndex: number };

type RowGroup = { key: string; label: string };

type RowSizeKind = 'model' | 'header' | 'header-spaced' | 'action' | 'not-selected' | 'no-results';

const rowSizeKind = (row: PickerRow): RowSizeKind => {
  if (row.kind === 'header') return row.spaced ? 'header-spaced' : 'header';
  return row.kind;
};

const measuredRowHeights = {
  model: 31,
  header: 30,
  'header-spaced': 38,
  action: 31,
  'not-selected': 31,
  'no-results': 56,
} satisfies Record<RowSizeKind, number>;

const STICKY_HEADER_OFFSET = 32;
const STICKY_FADE_MAX_SIZE = 52;
const STICKY_FADE_MIN_SIZE = 36;
const STICKY_FADE_CLEAR_MAX_SIZE = 28;

const favoriteSortId = (entry: ModelPickerEntry) => `${entry.providerID}:${entry.modelID}`;
const PROVIDER_SORT_PREFIX = 'provider:';

interface ModelPickerListProps {
  providers: ModelPickerProvider[];
  favoriteModels: ModelPickerFavoriteEntry[];
  recentModels: ModelPickerFavoriteEntry[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelect: (entry: ModelPickerEntry) => void;
  labels: {
    searchPlaceholder: string;
    list: string;
    noResults: string;
    favorites: string;
    recent: string;
    keyboardHint: string;
    notSelected?: string;
    favorite?: string;
    unfavorite?: string;
    provider?: string;
    capabilities?: string;
    capabilityToolCalling?: string;
    capabilityReasoning?: string;
    input?: string;
    output?: string;
    costPerMillion?: string;
  };
  selectedModel?: { providerID: string; modelID: string } | null;
  leadingEntry?: ModelPickerEntry | null;
  leadingAction?: { label: string; icon: React.ReactNode; onSelect: () => void } | null;
  onEntryDetails?: (entry: ModelPickerEntry) => void;
  providersStartCollapsed?: boolean;
  showKeyboardHints?: boolean;
  searchAction?: { label: string; icon: IconName; onSelect: () => void } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
  includeNotSelected?: boolean;
  onSelectNone?: () => void;
  selectionCount?: (entry: ModelPickerEntry) => number;
  disabled?: boolean;
  maxHeightClassName?: string;
  maxHeightStyle?: React.CSSProperties;
  sectionHeaderClassName?: string;
  sheetCaptions?: boolean;
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
  providerOrder?: string[];
  onReorderProvider?: (orderedProviderIDs: string[]) => void;
  reorderProviderTitle?: string;
  footerContent?: React.ReactNode | ((activeEntry: ModelPickerEntry | undefined) => React.ReactNode);
  renderVersion?: number;
  tooltipsEnabled?: boolean;
}

export const ModelPickerList: React.FC<ModelPickerListProps> = ({
  providers,
  favoriteModels,
  recentModels,
  searchQuery,
  onSearchQueryChange,
  onSelect,
  labels,
  selectedModel,
  leadingEntry = null,
  leadingAction = null,
  searchAction = null,
  onEntryDetails,
  providersStartCollapsed = false,
  showKeyboardHints = true,
  hiddenModels = [],
  allowedProviderIds,
  isModelAllowed,
  includeNotSelected = false,
  onSelectNone,
  selectionCount,
  disabled = false,
  maxHeightClassName = 'max-h-[min(400px,calc(100dvh-12rem))] flex-1',
  maxHeightStyle,
  sectionHeaderClassName,
  sheetCaptions = false,
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
  providerOrder,
  onReorderProvider,
  reorderProviderTitle,
  footerContent,
  renderVersion,
  tooltipsEnabled = true,
}) => {
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  useConfigStore((state) => state.modelsMetadata);
  useConfigStore((state) => state.providers);
  const selectionStoreRef = React.useRef<IndexSelectionStore | null>(null);
  if (!selectionStoreRef.current) selectionStoreRef.current = createIndexSelectionStore();
  const selectionStore = selectionStoreRef.current;
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const attachScroller = React.useCallback((element: HTMLElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  }, []);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const listboxId = React.useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const stickyFadeSizeRef = React.useRef(0);
  const keyboardOwnsSelectionRef = React.useRef(false);
  const lastMousePositionRef = React.useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = React.useRef(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  // external: https://developer.mozilla.org/en-US/docs/Web/API/Element/contextmenu_event Android can report a long press as a context menu too; open details once.
  const longPressRef = React.useRef<{ timer: number; x: number; y: number } | null>(null);
  const detailsOpenedAtRef = React.useRef(0);
  const cancelLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };
  React.useEffect(() => () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
  }, []);
  const openDetails = (entry: ModelPickerEntry) => {
    if (!onEntryDetails || performance.now() - detailsOpenedAtRef.current < 700) return;
    detailsOpenedAtRef.current = performance.now();
    onEntryDetails(entry);
  };
  const detailsHandlers = (entry: ModelPickerEntry): React.HTMLAttributes<HTMLDivElement> => (onEntryDetails ? {
    onPointerDown: (event) => {
      cancelLongPress();
      if (event.pointerType !== 'touch') return;
      const timer = window.setTimeout(() => {
        longPressRef.current = null;
        swallowGestureClick();
        openDetails(entry);
      }, 500);
      longPressRef.current = { timer, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event) => {
      const press = longPressRef.current;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancelLongPress();
    },
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onContextMenu: (event) => {
      event.preventDefault();
      cancelLongPress();
      openDetails(entry);
    },
  } : {});
  const collapsedRecord = useModelPickerSectionsStore((state) => state.collapsedSections);
  const toggleStoredSection = useModelPickerSectionsStore((state) => state.toggleSection);
  const setSectionCollapsed = useModelPickerSectionsStore((state) => state.setSectionCollapsed);
  const searching = searchQuery.trim().length > 0;
  const selectedProviderKey = selectedModel ? `provider:${selectedModel.providerID}` : null;
  const isSectionCollapsed = React.useCallback((key: string) => {
    const startsCollapsed = providersStartCollapsed && key.startsWith('provider:');
    if (startsCollapsed && searching) return false;
    if (collapsedRecord[key]) return true;
    return startsCollapsed && !collapsedRecord[`open:${key}`] && key !== selectedProviderKey;
  }, [collapsedRecord, providersStartCollapsed, searching, selectedProviderKey]);
  const toggleSection = React.useCallback((key: string) => {
    if (providersStartCollapsed && key.startsWith('provider:')) setSectionCollapsed(key, !isSectionCollapsed(key));
    else toggleStoredSection(key);
  }, [isSectionCollapsed, providersStartCollapsed, setSectionCollapsed, toggleStoredSection]);
  const sortSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const allowedProviderSet = React.useMemo(() => {
    if (!allowedProviderIds) return null;
    return new Set(allowedProviderIds);
  }, [allowedProviderIds]);

  const providerById = React.useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const hiddenKeys = React.useMemo(
    () => new Set(hiddenModels.map((hidden) => `${hidden.providerID}:${hidden.modelID}`)),
    [hiddenModels],
  );
  const isHidden = React.useCallback(
    (providerID: string, modelID: string) => hiddenKeys.has(`${providerID}:${modelID}`),
    [hiddenKeys],
  );

  const matchesQuery = React.useCallback(
    (modelName: string, providerName: string, modelID?: string) =>
      matchesRankQuery([modelName, modelID, providerName], searchQuery),
    [searchQuery],
  );

  const filteredFavorites = React.useMemo(() => favoriteModels.filter(({ model, providerID, modelID }) => {
    if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
    if (isModelAllowed && !isModelAllowed(providerID, modelID)) return false;
    if (isHidden(providerID, modelID)) return false;
    const providerName = providerById.get(providerID)?.name || providerID;
    return matchesQuery(getModelDisplayName(model), providerName, modelID);
  }), [allowedProviderSet, favoriteModels, isHidden, isModelAllowed, matchesQuery, providerById]);

  const filteredRecents = React.useMemo(() => {
    const favoriteIds = new Set(favoriteModels.map(favoriteSortId));
    return recentModels.filter((entry) => {
      const { model, providerID, modelID } = entry;
      if (favoriteIds.has(favoriteSortId(entry))) return false;
      if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
      if (isModelAllowed && !isModelAllowed(providerID, modelID)) return false;
      if (isHidden(providerID, modelID)) return false;
      const providerName = providerById.get(providerID)?.name || providerID;
      return matchesQuery(getModelDisplayName(model), providerName, modelID);
    });
  }, [allowedProviderSet, favoriteModels, isHidden, isModelAllowed, matchesQuery, providerById, recentModels]);

  const orderedProviders = React.useMemo(() => {
    if (!providerOrder || providerOrder.length === 0) return providers;
    const rank = new Map(providerOrder.map((id, index) => [id, index] as const));
    const ranked = providers
      .filter((provider) => rank.has(provider.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const unranked = providers.filter((provider) => !rank.has(provider.id));
    return [...ranked, ...unranked];
  }, [providerOrder, providers]);

  const filteredProviders = React.useMemo(() => orderedProviders
    .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
    .map((provider) => {
      const models = Array.isArray(provider.models) ? provider.models : [];
      const filteredModels = models.filter((model) => {
        const modelID = typeof model.id === 'string' ? model.id : '';
        if (!modelID || isHidden(provider.id, modelID)) return false;
        if (isModelAllowed && !isModelAllowed(provider.id, modelID)) return false;
        return matchesQuery(getModelDisplayName(model), provider.name || provider.id, modelID);
      });
      return { ...provider, models: filteredModels };
    })
    .filter((provider) => provider.models.length > 0), [allowedProviderSet, isHidden, isModelAllowed, matchesQuery, orderedProviders]);

  const visibleLeadingEntry = React.useMemo(() => {
    if (!leadingEntry) return null;
    return matchesQuery(getModelDisplayName(leadingEntry.model), leadingEntry.providerID, leadingEntry.modelID) ? leadingEntry : null;
  }, [leadingEntry, matchesQuery]);

  const showLeadingAction = Boolean(leadingAction) && !searchQuery.trim();
  const favoriteSortingEnabled = Boolean(onReorderFavorite) && searchQuery.trim().length === 0 && filteredFavorites.length > 1;
  const providerSortingEnabled = Boolean(onReorderProvider) && searchQuery.trim().length === 0 && !allowedProviderSet && filteredProviders.length > 1;
  const draggingProvider = draggingId?.startsWith(PROVIDER_SORT_PREFIX) ?? false;

  const { rows, navigation, navToRow } = React.useMemo(() => {
    const rows: PickerRow[] = [];
    const navigation: NavigationItem[] = [];
    const navToRow: number[] = [];
    const pushModel = (key: string, group: RowGroup | null, section: SectionKind, entry: ModelPickerEntry) => {
      navToRow.push(rows.length);
      rows.push({ kind: 'model', key, group, section, entry, navIndex: navigation.length });
      navigation.push(entry);
    };
    if (includeNotSelected) rows.push({ kind: 'not-selected', key: 'not-selected', group: null });
    const hasModels = Boolean(visibleLeadingEntry) || filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;
    if (!hasModels) rows.push({ kind: 'no-results', key: 'no-results', group: null });
    if (visibleLeadingEntry) {
      pushModel(`leading-${visibleLeadingEntry.providerID}-${visibleLeadingEntry.modelID}`, null, 'leading', visibleLeadingEntry);
    }
    if (leadingAction && showLeadingAction) {
      navToRow.push(rows.length);
      rows.push({ kind: 'action', key: 'leading-action', group: null, navIndex: navigation.length });
      navigation.push(LEADING_ACTION_SLOT);
    }
    const pushSection = (sectionKey: string, label: string, section: SectionKind, entries: ModelPickerEntry[], collapsed: boolean, providerId?: string) => {
      const group = { key: sectionKey, label };
      rows.push({ kind: 'header', key: `header:${sectionKey}`, group, sectionKey, spaced: rows.length > 0, collapsed, providerId });
      if (collapsed) return;
      for (const entry of entries) {
        pushModel(`${section}-${entry.providerID}-${entry.modelID}`, group, section, entry);
      }
    };
    if (filteredFavorites.length > 0) pushSection('favorites', labels.favorites, 'fav', filteredFavorites, isSectionCollapsed('favorites'));
    if (filteredRecents.length > 0) pushSection('recent', labels.recent, 'recent', filteredRecents, isSectionCollapsed('recent'));
    for (const provider of filteredProviders) {
      const sectionKey = `provider:${provider.id}`;
      const collapsed = draggingProvider || isSectionCollapsed(sectionKey);
      // SAFETY: filteredProviders keeps only models whose id is a non-empty string.
      const entries = provider.models.map((model) => ({ model, providerID: provider.id, modelID: model.id as string }));
      pushSection(sectionKey, provider.name || provider.id, 'provider', entries, collapsed, provider.id);
    }
    return { rows, navigation, navToRow };
  }, [isSectionCollapsed, draggingProvider, filteredFavorites, filteredProviders, filteredRecents, includeNotSelected, labels.favorites, labels.recent, leadingAction, showLeadingAction, visibleLeadingEntry]);

  const favoriteLookup: Map<string, ModelPickerEntry> = React.useMemo(() => new Map(
    filteredFavorites.map((entry) => [favoriteSortId(entry), entry] as const),
  ), [filteredFavorites]);

  const [scrollMargin, setScrollMargin] = React.useState(0);
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollElement) return;
    const next = list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
    setScrollMargin((previous) => (Math.abs(previous - next) < 0.5 ? previous : next));
  }, [scrollElement]);

  const draggingRowIndex = React.useMemo(() => {
    if (!draggingId) return -1;
    return rows.findIndex((row) => (row.kind === 'header' && row.providerId && `${PROVIDER_SORT_PREFIX}${row.providerId}` === draggingId)
      || (row.kind === 'model' && row.section === 'fav' && favoriteSortId(row.entry) === draggingId));
  }, [draggingId, rows]);
  const rangeExtractor = React.useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    if (draggingRowIndex < 0 || indexes.includes(draggingRowIndex)) return indexes;
    return [...indexes, draggingRowIndex].sort((a, b) => a - b);
  }, [draggingRowIndex]);

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: 0, height: window.innerHeight },
    estimateSize: (index) => {
      const row = rows[index];
      return row ? measuredRowHeights[rowSizeKind(row)] : measuredRowHeights.model;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
    scrollMargin,
    scrollPaddingStart: stickyHeaders ? STICKY_HEADER_OFFSET : 0,
    rangeExtractor,
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      callback({ width: rect.width, height: Math.min(rect.height, window.innerHeight) });
    }),
  });
  const virtualItems = virtualizer.getVirtualItems();

  const measuredKindsRef = React.useRef(new Set<RowSizeKind>());
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let changed = false;
    for (const element of list.querySelectorAll<HTMLElement>('[data-row-size-kind]')) {
      const kind = element.dataset.rowSizeKind as RowSizeKind;
      if (measuredKindsRef.current.has(kind)) continue;
      const height = element.offsetHeight;
      if (height <= 0) continue;
      measuredKindsRef.current.add(kind);
      if (Math.abs(measuredRowHeights[kind] - height) >= 0.5) {
        measuredRowHeights[kind] = height;
        changed = true;
      }
    }
    if (changed) virtualizer.measure();
  });

  const hasResults = navigation.some((item) => item !== LEADING_ACTION_SLOT);
  const selectedModelIndex = searchQuery.trim() || !selectedModel ? 0 : navigation.findIndex((item) => {
    const entry = entryOf(item);
    return entry?.providerID === selectedModel.providerID && entry.modelID === selectedModel.modelID;
  });
  const initialSelectionIndex = Math.max(0, selectedModelIndex);
  const revealRequest = `${searchQuery}\n${selectedModel?.providerID ?? ''}\n${selectedModel?.modelID ?? ''}`;
  const revealedRequestRef = React.useRef<string | null>(null);

  const navToRowRef = React.useRef(navToRow);
  React.useLayoutEffect(() => {
    navToRowRef.current = navToRow;
  }, [navToRow]);
  const revealIndex = React.useCallback((navIndex: number) => {
    const rowIndex = navToRowRef.current[navIndex];
    if (rowIndex === undefined || !scrollRef.current) return;
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
  }, [virtualizer]);

  React.useLayoutEffect(() => {
    selectionStore.set(initialSelectionIndex);
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    if (revealedRequestRef.current === revealRequest) return;
    if (selectedModelIndex < 0 || !scrollElement) return;
    revealedRequestRef.current = revealRequest;
    revealIndex(selectedModelIndex);
  }, [initialSelectionIndex, revealIndex, revealRequest, scrollElement, selectedModelIndex, selectionStore]);

  const selectIndex = React.useCallback((index: number) => {
    selectionStore.set(index);
    onActiveEntryChange?.(entryOf(navigation[index]));
  }, [navigation, onActiveEntryChange, selectionStore]);

  const moveSelection = React.useCallback((direction: 1 | -1) => {
    const total = navigation.length;
    if (total === 0) return;
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    const currentIndex = selectionStore.getSnapshot();
    const nextIndex = (currentIndex + direction + total) % total;
    selectionStore.set(nextIndex);
    onActiveEntryChange?.(entryOf(navigation[nextIndex]));
    requestAnimationFrame(() => revealIndex(nextIndex));
  }, [navigation, onActiveEntryChange, revealIndex, selectionStore]);

  React.useEffect(() => {
    onActiveEntryChange?.(entryOf(navigation[selectionStore.getSnapshot()]));
  }, [navigation, initialSelectionIndex, onActiveEntryChange, selectionStore]);

  const syncActiveDescendant = React.useCallback(() => {
    const input = searchInputRef.current;
    if (!input) return;
    const id = itemRefs.current[selectionStore.getSnapshot()]?.id;
    if (!id) input.removeAttribute('aria-activedescendant');
    else if (input.getAttribute('aria-activedescendant') !== id) input.setAttribute('aria-activedescendant', id);
  }, [selectionStore]);

  React.useEffect(() => {
    syncActiveDescendant();
    return selectionStore.subscribe(syncActiveDescendant);
  }, [selectionStore, syncActiveDescendant]);

  const itemRefSettersRef = React.useRef(new Map<number, (element: HTMLDivElement | null) => void>());
  const getItemRef = (rowIndex: number) => {
    let setter = itemRefSettersRef.current.get(rowIndex);
    if (!setter) {
      setter = (element: HTMLDivElement | null) => {
        itemRefs.current[rowIndex] = element;
        if (rowIndex !== selectionStore.getSnapshot()) return;
        if (element) syncActiveDescendant();
        else queueMicrotask(syncActiveDescendant);
      };
      itemRefSettersRef.current.set(rowIndex, setter);
    }
    return setter;
  };

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (handleDropdownNavigationKey(event, (navigationKey) => {
      moveSelection(navigationKey === 'ArrowDown' ? 1 : -1);
    })) return;
    event.stopPropagation();
    const activeItem = navigation[selectionStore.getSnapshot()];
    const activeEntry = entryOf(activeItem);
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      if (activeEntry && onVariantKey?.(event, activeEntry)) return;
    }
    onActiveKeyDown?.(event, activeEntry);
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
      if (disabled) return;
      if (activeItem === LEADING_ACTION_SLOT) leadingAction?.onSelect();
      else if (activeEntry) onSelect(activeEntry);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    }
  }, [disabled, leadingAction, moveSelection, navigation, onActiveKeyDown, onEscape, onSelect, onVariantKey, selectionStore]);

  const syncStickyFade = React.useCallback((scroller: HTMLElement) => {
    const hasTopScroll = scroller.scrollTop > 1;
    const fadeSize = hasTopScroll
      ? Math.min(STICKY_FADE_MIN_SIZE + scroller.scrollTop, STICKY_FADE_MAX_SIZE)
      : 0;
    stickyFadeSizeRef.current = fadeSize;
    const fadeRoot = scroller.closest<HTMLElement>('.oc-sticky-fade-root');
    fadeRoot?.style.setProperty('--scroll-shadow-top-size', `${fadeSize}px`);
    fadeRoot?.style.setProperty(
      '--scroll-shadow-top-clear-size',
      `${Math.min(Math.max(fadeSize - 8, 0), STICKY_FADE_CLEAR_MAX_SIZE)}px`,
    );
  }, []);

  const blockStickyFadeInteraction = React.useCallback((
    event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>,
  ) => {
    if ((event.target as Element).closest('[data-overlay-scrollbar-thumb], [data-model-picker-sticky-header]')) return;
    if (event.type === 'click' && event.detail === 0) return;
    const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (eventY >= stickyFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  React.useLayoutEffect(() => {
    if (stickyHeaders && scrollRef.current) syncStickyFade(scrollRef.current);
  }, [stickyHeaders, syncStickyFade, rows]);

  const captionClassName = sheetCaptions
    ? 'typography-micro font-semibold uppercase tracking-wider'
    : 'typography-meta font-medium';
  const headerClassName = cn(
    'text-muted-foreground flex items-center gap-2 px-2 py-1.5',
    captionClassName,
    sectionHeaderClassName,
  );

  const highlightOnPointer = (event: React.MouseEvent, rowIndex: number) => {
    const nextPosition = { x: event.clientX, y: event.clientY };
    const previousPosition = lastMousePositionRef.current;
    const pointerMoved = !previousPosition || previousPosition.x !== nextPosition.x || previousPosition.y !== nextPosition.y;
    lastMousePositionRef.current = nextPosition;

    if (keyboardOwnsSelectionRef.current && !previousPosition) return;
    if (keyboardOwnsSelectionRef.current && !pointerMoved) return;
    if (keyboardOwnsSelectionRef.current && pointerMoved) keyboardOwnsSelectionRef.current = false;
    selectIndex(rowIndex);
  };

  const rowHighlightClassName = (isHighlighted: boolean) => cn(
    'w-full text-start px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer [@media(pointer:coarse)]:min-h-11',
    !disabled && (isHighlighted
      ? 'oc-selected text-interactive-selection-foreground'
      : 'hover:bg-interactive-hover/50'),
    disabled && 'cursor-not-allowed opacity-60',
    rowClassName,
  );

  const describeEntry = React.useCallback((entry: ModelPickerEntry) => ({
    metadata: mergeModelMetadataWithLiveModel(entry.providerID, entry.model, getModelMetadata(entry.providerID, entry.modelID)),
    providerName: entry === visibleLeadingEntry ? null : providerById.get(entry.providerID)?.name || entry.providerID,
  }), [getModelMetadata, providerById, visibleLeadingEntry]);

  const renderAction = (action: NonNullable<typeof leadingAction>, navIndex: number) => (
    <ModelPickerRowHighlight store={selectionStore} index={navIndex} renderVersion={renderVersion}>
      {(isHighlighted) => (
        <div
          ref={getItemRef(navIndex)}
          id={optionId(navIndex)}
          role="option"
          aria-selected={false}
          aria-disabled={disabled || undefined}
          tabIndex={-1}
          onClick={() => { if (!disabled) action.onSelect(); }}
          onMouseEnter={(event) => highlightOnPointer(event, navIndex)}
          onMouseMove={(event) => highlightOnPointer(event, navIndex)}
          className={rowHighlightClassName(isHighlighted)}
        >
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {action.icon}
            <span className="font-medium truncate">{action.label}</span>
          </div>
        </div>
      )}
    </ModelPickerRowHighlight>
  );

  const renderModelRow = (row: Extract<PickerRow, { kind: 'model' }>, shell?: SortableShell) => {
    const { entry, section, navIndex } = row;
    const showProviderLogo = section === 'fav' || section === 'recent';
    const metadata = mergeModelMetadataWithLiveModel(entry.providerID, entry.model, getModelMetadata(entry.providerID, entry.modelID));
    const contextTokens = formatModelContextTokens(metadata?.limit?.context);
    const count = selectionCount?.(entry) ?? 0;
    const isSelected = selectedModel?.providerID === entry.providerID && selectedModel.modelID === entry.modelID;
    const favorite = isFavorite?.(entry) ?? false;
    const providerName = section === 'leading' ? null : providerById.get(entry.providerID)?.name || entry.providerID;
    const handleMouseActivity = (event: React.MouseEvent) => highlightOnPointer(event, navIndex);
    const rowId = optionId(navIndex);
    const itemRef = getItemRef(navIndex);

    return (
      <ModelPickerRowHighlight store={selectionStore} index={navIndex} renderVersion={renderVersion}>
        {(isHighlighted) => {
          const rowEnd = renderRowEnd?.(entry, { isHighlighted, isSelected });
          return (
            <div
              ref={shell ? (element) => { itemRef(element); shell.setNodeRef(element); shell.setActivatorNodeRef(element); } : itemRef}
              {...detailsHandlers(entry)}
              {...(shell?.listeners ?? {})}
              style={shell?.style}
              id={rowId}
              role="option"
              aria-labelledby={`${rowId}-name ${rowId}-provider ${rowId}-context ${rowId}-count ${rowId}-end`}
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              tabIndex={-1}
              onClick={() => {
                if (suppressClickRef.current || disabled) return;
                onSelect(entry);
              }}
              onKeyDown={(event) => {
                if (disabled || event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(entry);
                }
              }}
              onMouseEnter={handleMouseActivity}
              onMouseMove={handleMouseActivity}
              className={cn(
                rowHighlightClassName(isHighlighted),
                'group/row',
                (shell || onEntryDetails) && 'select-none',
                onEntryDetails && '[-webkit-touch-callout:none]',
                shell?.isDragging && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                {section === 'leading' ? <Icon name="openchamber" className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                {showProviderLogo ? <ProviderLogo providerId={entry.providerID} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <span id={`${rowId}-name`} className="font-medium truncate">{getModelDisplayName(entry.model)}</span>
                {showProviderLogo && providerName ? <span id={`${rowId}-provider`} className="sr-only">{providerName}</span> : null}
                {contextTokens ? <span id={`${rowId}-context`} className={cn('typography-micro flex-shrink-0', isHighlighted ? 'text-interactive-selection-foreground/70' : 'text-muted-foreground')}>{contextTokens}</span> : null}
              </div>
              {count > 0 ? <span id={`${rowId}-count`} className={cn('typography-micro flex-shrink-0', isHighlighted ? 'text-interactive-selection-foreground/70' : 'text-muted-foreground')}>x{count}</span> : null}
              {rowEnd ? <span id={`${rowId}-end`} className="flex">{rowEnd}</span> : null}
              {isSelected ? <Icon name="check" className="h-4 w-4 text-inherit flex-shrink-0" /> : null}
              {onToggleFavorite && section !== 'leading' ? (
                <button
                  type="button"
                  disabled={disabled}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onTouchStart={(event) => event.stopPropagation()}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (event.currentTarget === document.activeElement) searchInputRef.current?.focus(); onToggleFavorite(entry); }}
                  className={cn(
                    'model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80 flex-shrink-0 disabled:pointer-events-none',
                    favorite ? 'text-primary' : 'text-muted-foreground',
                    !favorite && !isHighlighted && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                    onEntryDetails && '[@media(hover:none)]:hidden',
                  )}
                  aria-label={favorite ? labels.unfavorite : labels.favorite}
                  title={favorite ? labels.unfavorite : labels.favorite}
                >
                  <Icon name={favorite ? 'star-fill' : 'star'} className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );
        }}
      </ModelPickerRowHighlight>
    );
  };

  const renderSectionIdentity = (sectionKey: string): React.ReactNode => {
    if (sectionKey === 'favorites') {
      return <><Icon name="star-fill" className="h-4 w-4 flex-shrink-0 text-primary" /><span className="min-w-0 truncate">{labels.favorites}</span></>;
    }
    if (sectionKey === 'recent') {
      return <><Icon name="time" className="h-4 w-4 flex-shrink-0" /><span className="min-w-0 truncate">{labels.recent}</span></>;
    }
    const providerId = sectionKey.startsWith('provider:') ? sectionKey.slice('provider:'.length) : '';
    const provider = providerById.get(providerId);
    if (!provider) return null;
    return <><ProviderLogo providerId={providerId} className="h-4 w-4 flex-shrink-0" /><span className="min-w-0 truncate">{provider.name || provider.id}</span></>;
  };

  const renderChevron = (collapsed: boolean) => (
    <span className={cn('ms-auto flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground', !collapsed && 'opacity-0 group-hover/header:opacity-100 group-focus-visible/header:opacity-100')}>
      <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
    </span>
  );

  const renderHeader = (row: Extract<PickerRow, { kind: 'header' }>, shell?: SortableShell) => {
    const toggle = () => {
      if (suppressClickRef.current) return;
      toggleSection(row.sectionKey);
    };
    const collapsed = isSectionCollapsed(row.sectionKey);
    if (shell) {
      return (
        <div
          ref={(element) => { shell.setNodeRef(element); shell.setActivatorNodeRef(element); }}
          {...shell.listeners}
          style={shell.style}
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          title={reorderProviderTitle}
          className={cn(headerClassName, 'group/header w-full text-start cursor-pointer select-none', shell.isDragging && 'opacity-0')}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleSection(row.sectionKey);
            }
          }}
        >
          {renderSectionIdentity(row.sectionKey)}
          {renderChevron(collapsed)}
        </div>
      );
    }
    return (
      <button
        type="button"
        className={cn(headerClassName, 'group/header w-full text-start cursor-pointer')}
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        {renderSectionIdentity(row.sectionKey)}
        {renderChevron(collapsed)}
      </button>
    );
  };

  const renderRowContent = (row: PickerRow): React.ReactNode => {
    switch (row.kind) {
      case 'not-selected':
        return (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 typography-meta text-muted-foreground hover:bg-interactive-hover/50"
            onClick={onSelectNone}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
            <span>{labels.notSelected}</span>
            {!selectedModel ? <Icon name="check" className="h-4 w-4 text-inherit ms-auto" /> : null}
          </button>
        );
      case 'no-results':
        return <div className="px-2 py-4 text-center typography-meta text-muted-foreground">{labels.noResults}</div>;
      case 'action':
        return leadingAction ? renderAction(leadingAction, row.navIndex) : null;
      case 'header':
        if (row.providerId && providerSortingEnabled) {
          return (
            <SortableRow id={`${PROVIDER_SORT_PREFIX}${row.providerId}`} disabled={disabled}>
              {(shell) => renderHeader(row, shell)}
            </SortableRow>
          );
        }
        return renderHeader(row);
      case 'model':
        if (row.section === 'fav' && favoriteSortingEnabled) {
          return (
            <SortableRow id={favoriteSortId(row.entry)} disabled={disabled}>
              {(shell) => renderModelRow(row, shell)}
            </SortableRow>
          );
        }
        return renderModelRow(row);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDraggingId(String(event.active.id));
  };

  const finishDrag = () => {
    setDraggingId(null);
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    finishDrag();
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId.startsWith(PROVIDER_SORT_PREFIX)) {
      if (!onReorderProvider || !overId.startsWith(PROVIDER_SORT_PREFIX)) return;
      const ids = orderedProviders.map((provider) => provider.id);
      const from = ids.indexOf(activeId.slice(PROVIDER_SORT_PREFIX.length));
      const to = ids.indexOf(overId.slice(PROVIDER_SORT_PREFIX.length));
      if (from === -1 || to === -1) return;
      onReorderProvider(arrayMove(ids, from, to));
      return;
    }
    const activeFavorite = favoriteLookup.get(activeId);
    const overFavorite = favoriteLookup.get(overId);
    if (!onReorderFavorite || !activeFavorite || !overFavorite) return;
    onReorderFavorite(activeFavorite, overFavorite);
  };

  const stuckSectionKey = (() => {
    if (!stickyHeaders) return null;
    const offset = (virtualizer.scrollOffset ?? 0) - scrollMargin;
    const topItem = virtualItems.find((item) => item.end - scrollMargin > offset + 1);
    let section: string | null = null;
    if (topItem) {
      for (let index = topItem.index; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.kind === 'header') { section = row.sectionKey; break; }
      }
    }
    if (section) return section;
    if (includeNotSelected) return null;
    const firstHeader = rows.find((row) => row.kind === 'header');
    return firstHeader?.kind === 'header' ? firstHeader.sectionKey : null;
  })();

  const groupedItems: { group: RowGroup | null; items: VirtualItem[] }[] = [];
  for (const item of virtualItems) {
    const group = rows[item.index]?.group ?? null;
    const last = groupedItems[groupedItems.length - 1];
    if (last && last.group?.key === group?.key) last.items.push(item);
    else groupedItems.push({ group, items: [item] });
  }
  const renderVirtualItem = (item: VirtualItem) => {
    const row = rows[item.index];
    if (!row) return null;
    const sizeKind = rowSizeKind(row);
    return (
      <div
        key={item.key}
        data-row-size-kind={sizeKind}
        className={cn('absolute inset-s-0 top-0 w-full', sizeKind === 'header-spaced' && 'pt-2')}
        style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
      >
        {renderRowContent(row)}
      </div>
    );
  };

  const sortableIds = React.useMemo(() => {
    const ids: string[] = [];
    if (favoriteSortingEnabled) for (const entry of filteredFavorites) ids.push(favoriteSortId(entry));
    if (providerSortingEnabled) for (const provider of filteredProviders) ids.push(`${PROVIDER_SORT_PREFIX}${provider.id}`);
    return ids;
  }, [favoriteSortingEnabled, filteredFavorites, filteredProviders, providerSortingEnabled]);

  const list = (
    <div className="px-1">
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={labels.list}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {groupedItems.map(({ group, items }) => (group
          ? <div key={`group:${group.key}`} role="group" aria-label={group.label} className="contents">{items.map(renderVirtualItem)}</div>
          : items.map(renderVirtualItem)))}
      </div>
    </div>
  );

  return (
    <>
      <div className="flex items-center gap-2 px-2 py-1 border-b border-edge-muted">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder={labels.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-autocomplete="list"
            className={PICKER_SEARCH_INPUT_CLASS}
            autoFocus={autoFocus}
          />
        </div>
        {searchAction ? (
          <button
            type="button"
            onClick={searchAction.onSelect}
            className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap pe-1 typography-micro text-muted-foreground hover:text-foreground"
          >
            <Icon name={searchAction.icon} className="size-3.5" />
            {searchAction.label}
          </button>
        ) : null}
      </div>

      <div
        className="oc-sticky-fade-root relative flex min-h-0 flex-1"
        // SAFETY: these custom properties configure the viewport-owned edge fade.
        style={stickyHeaders ? { '--scroll-shadow-top-size': '0px' } as React.CSSProperties : undefined}
        onPointerDownCapture={stickyHeaders ? blockStickyFadeInteraction : undefined}
        onClickCapture={stickyHeaders ? blockStickyFadeInteraction : undefined}
        onContextMenuCapture={stickyHeaders ? blockStickyFadeInteraction : undefined}
      >
        <ScrollableOverlay
          ref={attachScroller}
          useScrollShadow
          scrollShadowSize={12}
          outerClassName={maxHeightClassName}
          className="oc-sticky-fade-scroller overlay-scrollbar-target--no-gutter"
          style={maxHeightStyle}
          onScroll={stickyHeaders ? (event) => syncStickyFade(event.currentTarget) : undefined}
        >
          {sortableIds.length > 0 ? (
            <DndContext
              sensors={sortSensors}
              collisionDetection={closestCenter}
              measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={finishDrag}
            >
              <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                {list}
              </SortableContext>
              {createPortal(
                <DragOverlay>
                  {draggingProvider && draggingId ? (
                    <div className={cn(headerClassName, 'oc-glass-popover oc-glass-floating rounded-md')}>
                      {renderSectionIdentity(`provider:${draggingId.slice(PROVIDER_SORT_PREFIX.length)}`)}
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          ) : list}
        </ScrollableOverlay>
        {stickyHeaders && stuckSectionKey ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-model-picker-sticky-header="true"
            onClick={() => toggleSection(stuckSectionKey)}
            className={cn('oc-sticky-fade-overlay absolute inset-x-0 top-0 z-30 flex items-center gap-2 px-3 py-1.5 text-start text-muted-foreground', captionClassName)}
          >
            {renderSectionIdentity(stuckSectionKey)}
          </button>
        ) : null}
      </div>

      {showKeyboardHints ? (
        <div className="px-3 pt-1 pb-1.5 border-t border-edge-muted typography-micro text-muted-foreground [@media(pointer:coarse)]:hidden">
          <ModelPickerFooter store={selectionStore} navigationList={navigation} footerContent={footerContent} fallback={labels.keyboardHint} />
        </div>
      ) : null}

      <ModelPickerRowCard
        store={selectionStore}
        navigation={navigation}
        itemRefs={itemRefs}
        active={tooltipsEnabled && hasResults}
        layoutVersion={`${virtualItems[0]?.index ?? 0}:${virtualItems.length}:${rows.length}`}
        describe={describeEntry}
        labels={labels}
      />
    </>
  );
};
