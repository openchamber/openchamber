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

// The row sits inside the list's padding, so the card's offset from the row
// has to clear that padding too, or the card covers the picker's edge.
const ROW_TOOLTIP_OFFSET = 16;

// Card width (max-w-xs) plus its offset from the row. Narrower room on both
// sides means the card would land on top of the list it describes.
const ROW_TOOLTIP_ROOM = 320 + ROW_TOOLTIP_OFFSET;

/** The side with room for the details card, or null when neither side has it. */
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

/**
 * The details card of the highlighted row. One card serves the whole list and
 * anchors to whichever row is highlighted: a tooltip per row kept hundreds of
 * tooltip roots mounted for a card that shows at most once.
 */
const ModelPickerRowCard: React.FC<{
  store: IndexSelectionStore;
  navigation: readonly NavigationItem[];
  itemRefs: React.RefObject<(HTMLDivElement | null)[]>;
  active: boolean;
  /** Changes when rows mount or unmount, so a card whose row scrolled away closes. */
  layoutVersion: string;
  describe: (entry: ModelPickerEntry) => { metadata?: ModelMetadata; providerName: string | null };
  labels: ModelPickerListProps['labels'];
}> = ({ store, navigation, itemRefs, active, layoutVersion, describe, labels }) => {
  const index = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const entry = entryOf(navigation[index]);
  // Null until the hover delay passes, then the row and the side the card fits on.
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

  // Scrolling can unmount the row and mount it again: follow it to its new element.
  React.useLayoutEffect(() => {
    setPlacement((current) => {
      if (!current || current.anchor.isConnected) return current;
      const anchor = itemRefs.current[index];
      return anchor ? { ...current, anchor } : null;
    });
  }, [index, itemRefs, layoutVersion]);

  if (!entry || !placement || !placement.anchor.isConnected) return null;
  const { metadata, providerName } = describe(entry);
  // The provider line alone is worth a card: it tells apart same-named models
  // from different providers, including ones without capability or cost data.
  if (!providerName && !hasTooltipMetadata(metadata)) return null;

  return (
    <Tooltip open onOpenChange={() => {}}>
      <TooltipContent anchor={placement.anchor} side={placement.side} sideOffset={ROW_TOOLTIP_OFFSET} className="max-w-xs text-start transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100">
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

// The leading action's place in the keyboard list: it is highlighted and
// chosen like a row, but it is not a model entry.
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

/**
 * A sortable row: the whole row is what the pointer drags, past a few pixels
 * of movement, so a plain click still chooses it. dnd-kit's attributes are
 * left off, because they would turn the row's option role into a button.
 */
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

/**
 * The picker draws one flat list of rows, section captions included, and
 * mounts only the rows near the view. Sections used to virtualize on their
 * own past 40 models, so ten providers of 30 mounted 300 rows on every open.
 */
type PickerRow =
  | { kind: 'not-selected'; key: string; group: null }
  | { kind: 'no-results'; key: string; group: null }
  | { kind: 'action'; key: string; group: null; navIndex: number }
  | { kind: 'header'; key: string; group: RowGroup; sectionKey: string; spaced: boolean; collapsed: boolean; providerId?: string }
  | { kind: 'model'; key: string; group: RowGroup | null; section: SectionKind; entry: ModelPickerEntry; navIndex: number };

/** The section a row belongs to: `key` stays put while the list scrolls, `label` names it to a screen reader. */
type RowGroup = { key: string; label: string };

type RowSizeKind = 'model' | 'header' | 'header-spaced' | 'action' | 'not-selected' | 'no-results';

const rowSizeKind = (row: PickerRow): RowSizeKind => {
  if (row.kind === 'header') return row.spaced ? 'header-spaced' : 'header';
  return row.kind;
};

// Rows of one kind share a height, which follows the UI font size. The last
// measured heights are kept across opens, so a list lays out right at once.
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
    /** Screen reader name of the list of models. */
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
  /**
   * A row pinned above favorites and providers: the Auto routing entry. It is
   * not one of `providers`, takes part in keyboard navigation like any row,
   * and is filtered by the search query on its display name.
   */
  leadingEntry?: ModelPickerEntry | null;
  /**
   * An action pinned right after the leading entry (the composer's "Run on
   * several models"). It is not a model, but it looks and navigates like a
   * row: arrows and the pointer highlight it, Enter runs it. It hides while a
   * search query is typed.
   */
  leadingAction?: { label: string; icon: React.ReactNode; onSelect: () => void } | null;
  /**
   * Opens a model's details: a long press on touch, a right click with a mouse.
   * With it, a device without hover leaves the stars off the rows, since an
   * empty star there would show at all times; favoriting moves to the details.
   */
  onEntryDetails?: (entry: ModelPickerEntry) => void;
  /** Provider sections start closed, except the current model's (the phone's sheet). */
  providersStartCollapsed?: boolean;
  /** The footer of key hints; a touch sheet leaves it off whatever the pointer. */
  showKeyboardHints?: boolean;
  /** A quiet action at the end of the search row (the composer's "Add new provider"). */
  searchAction?: { label: string; icon: IconName; onSelect: () => void } | null;
  hiddenModels?: HiddenModel[];
  allowedProviderIds?: string[];
  /**
   * Per-model gate, for callers whose feature needs a capability rather than a
   * provider (e.g. structured output). Applied on top of `allowedProviderIds`.
   */
  isModelAllowed?: (providerID: string, modelID: string) => boolean;
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
  // getModelMetadata falls back to the provider's own model record for models
  // models.dev does not list. Subscribe to both sources it reads so rows
  // re-render when either arrives.
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
  // A drag ends with the pointer released over a row; that release is not a pick.
  const suppressClickRef = React.useRef(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  // A touch held still on a row opens its details; Android also reports that
  // press as a context menu, so the two open the details once.
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
    // There a search opens every matching provider, closed by hand or not,
    // without changing what is kept.
    if (startsCollapsed && searching) return false;
    if (collapsedRecord[key]) return true;
    // Otherwise only an opened provider, or the current model's, is open.
    return startsCollapsed && !collapsedRecord[`open:${key}`] && key !== selectedProviderKey;
  }, [collapsedRecord, providersStartCollapsed, searching, selectedProviderKey]);
  const toggleSection = React.useCallback((key: string) => {
    if (providersStartCollapsed && key.startsWith('provider:')) setSectionCollapsed(key, !isSectionCollapsed(key));
    else toggleStoredSection(key);
  }, [isSectionCollapsed, providersStartCollapsed, setSectionCollapsed, toggleStoredSection]);
  // Mouse: a drag starts after a short move, so a click still picks the row.
  // Touch: a long press starts it, so a swipe still scrolls the list.
  const sortSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const allowedProviderSet = React.useMemo(() => {
    // undefined = no restriction; [] = allow none. Treating empty like
    // "unrestricted" would resurface providers without a login in pickers that
    // intentionally pass the authenticated-only list.
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

  // Recent leaves out what Favorites already lists.
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
      // While a provider is dragged every provider shows only its caption, so
      // the captions are what moves.
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

  // The list's offset inside the scroller: anything drawn above the rows.
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
  // The dragged row stays mounted wherever the list scrolls.
  const rangeExtractor = React.useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    if (draggingRowIndex < 0 || indexes.includes(draggingRowIndex)) return indexes;
    return [...indexes, draggingRowIndex].sort((a, b) => a - b);
  }, [draggingRowIndex]);

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // The first render already holds a screenful of rows, the same ones the
    // capped view below keeps once the scroller attaches. Rows mounted only
    // after the popup did read to its height morph as a content change, and
    // the menu opened tall and eased down to its size.
    initialRect: { width: 0, height: window.innerHeight },
    estimateSize: (index) => {
      const row = rows[index];
      return row ? measuredRowHeights[rowSizeKind(row)] : measuredRowHeights.model;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
    scrollMargin,
    // A row scrolled into view lands below the sticky caption, not under it.
    scrollPaddingStart: stickyHeaders ? STICKY_HEADER_OFFSET : 0,
    rangeExtractor,
    // The menu's first layout comes before its positioner sets the room it
    // has, and the scroller is then as tall as every row: capped at the window,
    // the first frame mounts a screenful instead of the whole list.
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => {
      callback({ width: rect.width, height: Math.min(rect.height, window.innerHeight) });
    }),
  });
  const virtualItems = virtualizer.getVirtualItems();

  // One mounted row of each kind is measured instead of observing every row:
  // per-row observers re-measured the whole window on each frame of the
  // menu's open animation and cost more than the rows they saved.
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
  // Scrolling to the current model answers opening the list, a new query, or a
  // new selection, once the model has a row. A star or a collapsed section only
  // shifts rows around the pointer, so it must not scroll again.
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
    // Opening or scrolling the list must not let a stationary pointer replace the current model.
    keyboardOwnsSelectionRef.current = true;
    lastMousePositionRef.current = null;
    if (revealedRequestRef.current === revealRequest) return;
    // Models can load after the list opens: keep the request until the current
    // model's row exists. Until then there is nothing to scroll to.
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

  // Focus stays in the search field, so screen readers learn the highlighted
  // row from aria-activedescendant. It is written to the field directly: the
  // highlight lives outside React state so a key press re-renders two rows,
  // not the list. A row outside the view is unmounted; the field then points
  // at nothing until the row mounts and calls this again.
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

  // One ref callback per row index, kept across renders: a new callback on
  // every render made React detach and attach every row's ref each time.
  const itemRefSettersRef = React.useRef(new Map<number, (element: HTMLDivElement | null) => void>());
  const getItemRef = (rowIndex: number) => {
    let setter = itemRefSettersRef.current.get(rowIndex);
    if (!setter) {
      setter = (element: HTMLDivElement | null) => {
        itemRefs.current[rowIndex] = element;
        if (rowIndex !== selectionStore.getSnapshot()) return;
        // A re-render detaches the row's ref and attaches it again in one commit:
        // check once the commit is over, so the field does not lose the row and
        // get it back, which a screen reader would announce twice.
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
    // Enter or Space on a focused button clicks with no pointer position (detail 0,
    // coordinates 0), which would otherwise read as a click on the fade.
    if (event.type === 'click' && event.detail === 0) return;
    const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (eventY >= stickyFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  React.useLayoutEffect(() => {
    if (stickyHeaders && scrollRef.current) syncStickyFade(scrollRef.current);
  }, [stickyHeaders, syncStickyFade, rows]);

  const headerClassName = cn(
    'typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 px-2 py-1.5',
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
    // Rows meet the touch target floor under a finger.
    'w-full text-start px-2 py-1.5 rounded-md typography-meta flex items-center gap-2 cursor-pointer [@media(pointer:coarse)]:min-h-11',
    !disabled && (isHighlighted
      ? 'bg-interactive-selection text-interactive-selection-foreground'
      : 'hover:bg-interactive-hover/50'),
    disabled && 'cursor-not-allowed opacity-60',
    rowClassName,
  );

  const describeEntry = React.useCallback((entry: ModelPickerEntry) => ({
    metadata: mergeModelMetadataWithLiveModel(entry.providerID, entry.model, getModelMetadata(entry.providerID, entry.modelID)),
    // Same name as the provider's section header; the Auto row has no provider.
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
              // Named by its text, skipping the logo and the star button.
              aria-labelledby={`${rowId}-name ${rowId}-provider ${rowId}-context ${rowId}-count ${rowId}-end`}
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              tabIndex={-1}
              onClick={() => {
                if (suppressClickRef.current || disabled) return;
                onSelect(entry);
              }}
              onKeyDown={(event) => {
                // Keys pressed on a control inside the row (the star) belong to
                // that control, not to choosing the model.
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
                // A long press opens the details, not the system's text callout.
                onEntryDetails && '[-webkit-touch-callout:none]',
                shell?.isDragging && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                {section === 'leading' ? <Icon name="openchamber" className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                {showProviderLogo ? <ProviderLogo providerId={entry.providerID} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <span id={`${rowId}-name`} className="font-medium truncate">{getModelDisplayName(entry.model)}</span>
                {/* Favorites and Recent show the provider as a logo only. */}
                {showProviderLogo && providerName ? <span id={`${rowId}-provider`} className="sr-only">{providerName}</span> : null}
                {contextTokens ? <span id={`${rowId}-context`} className={cn('typography-micro flex-shrink-0', isHighlighted ? 'text-interactive-selection-foreground/70' : 'text-muted-foreground')}>{contextTokens}</span> : null}
              </div>
              {count > 0 ? <span id={`${rowId}-count`} className={cn('typography-micro flex-shrink-0', isHighlighted ? 'text-interactive-selection-foreground/70' : 'text-muted-foreground')}>x{count}</span> : null}
              {/* A flex wrapper keeps the caller's element laid out as a row item. */}
              {rowEnd ? <span id={`${rowId}-end`} className="flex">{rowEnd}</span> : null}
              {isSelected ? <Icon name="check" className="h-4 w-4 text-inherit flex-shrink-0" /> : null}
              {onToggleFavorite && section !== 'leading' ? (
                // Unstarring can remove this row. A focused star would take focus with it,
                // and the popup would hand focus to its last button, scrolling the list to
                // the bottom; focus stays in, or returns to, the search field instead.
                // An empty star waits for the row's hover; a set one stays.
                <button
                  type="button"
                  disabled={disabled}
                  onMouseDown={(event) => {
                    // Keeps focus in the field, and keeps the press from starting a row drag.
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

  // The chevron shows on the caption's hover, and always on a closed section,
  // so a closed one still reads as closed at rest.
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
      // The whole caption is what the pointer drags (past a few pixels, so a
      // plain click still folds the section). A <button> cannot take dnd-kit's
      // listeners without becoming a draggable widget, so this is a div with
      // button semantics.
      return (
        <div
          ref={(element) => { shell.setNodeRef(element); shell.setActivatorNodeRef(element); }}
          {...shell.listeners}
          style={shell.style}
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          title={reorderProviderTitle}
          // While dragged, the caption's copy follows the pointer (DragOverlay).
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

  // The caption the sticky overlay shows: the section of the row at the top of
  // the view, or the first section while rows above every section (Auto, Not
  // selected) are still in view.
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

  // Rows of one section sit in one group, so a screen reader names the section.
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
            className="h-7 rounded-none bg-transparent ps-8 pe-0 typography-meta ring-0 hover:[&:not(:focus)]:bg-transparent hover:[&:not(:focus)]:[background-image:none] focus:ring-0 focus-visible:ring-0"
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
          useScrollShadow={stickyHeaders}
          hideBottomScrollShadow
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
              {/* Every provider folds to its caption as the drag starts, so the
                  dragged caption moves away from the pointer; a copy follows it
                  instead. In the body, because a fixed element inside the
                  menu's transformed popup is placed off the pointer. */}
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
            className="oc-sticky-fade-overlay absolute inset-x-0 top-0 z-30 flex items-center gap-2 px-3 py-1.5 text-start typography-micro font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {renderSectionIdentity(stuckSectionKey)}
          </button>
        ) : null}
      </div>

      {/* Key hints mean nothing under a finger. */}
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
