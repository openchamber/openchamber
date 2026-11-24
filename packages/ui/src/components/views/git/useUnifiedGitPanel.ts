import React from 'react';
import { useUIStore, type PendingDiffScope } from '@/stores/useUIStore';
import { cancelWhenLayoutSettled, isLayoutAnimating, onLayoutAnimationStart, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import type { WorkingEntrySelection } from './UnifiedWorkingChangesBody';

const WIDE_PANEL_MIN_WIDTH = 720;

export type UnifiedPanelScope = Exclude<PendingDiffScope, 'staged'>;

export type WorkingFocusRequest = {
  path: string;
  staged: boolean;
  nonce: number;
};

const normalizeScope = (raw: PendingDiffScope | null | undefined): UnifiedPanelScope => {
  if (!raw || raw === 'staged') return 'working';
  return raw;
};

const clearPendingDiff = () => {
  useUIStore.setState({ pendingDiffFile: null, pendingDiffStaged: false, pendingDiffScope: null });
};

export function useUnifiedGitPanel(options: {
  isActive: boolean;
  isMobile: boolean;
  diffScope: PendingDiffScope | null;
  onDiffScopeChange?: (scope: PendingDiffScope) => void;
  targetFilePath: string | null;
}) {
  const { isActive, isMobile, diffScope, onDiffScopeChange, targetFilePath } = options;

  const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
  const pendingDiffStaged = useUIStore((state) => state.pendingDiffStaged);
  const pendingDiffScope = useUIStore((state) => state.pendingDiffScope);
  const pendingTurnDiffFile = useUIStore((state) => state.pendingTurnDiffFile);

  const [activeScope, setActiveScope] = React.useState<UnifiedPanelScope>(() => normalizeScope(diffScope));
  const [prevDiffScope, setPrevDiffScope] = React.useState(diffScope);
  if (prevDiffScope !== diffScope) {
    setPrevDiffScope(diffScope);
    if (diffScope !== null) setActiveScope(normalizeScope(diffScope));
  }

  const onDiffScopeChangeRef = React.useRef(onDiffScopeChange);
  onDiffScopeChangeRef.current = onDiffScopeChange;

  const handleScopeChange = React.useCallback((next: PendingDiffScope) => {
    const normalized = normalizeScope(next);
    setActiveScope(normalized);
    onDiffScopeChangeRef.current?.(normalized);
  }, []);

  const [wideByWidth, setWideByWidth] = React.useState(false);
  const wideByWidthRef = React.useRef(false);
  const setPanelWidth = React.useCallback((width: number) => {
    const next = width >= WIDE_PANEL_MIN_WIDTH;
    if (wideByWidthRef.current === next) return;
    wideByWidthRef.current = next;
    setWideByWidth(next);
  }, []);
  const releaseRootRef = React.useRef<(() => void) | null>(null);
  const setRootRef = React.useCallback((node: HTMLDivElement | null) => {
    releaseRootRef.current?.();
    releaseRootRef.current = null;
    if (!node) return;
    const zoneSize = (): number | null => {
      const zone = node.closest<HTMLElement>('[data-context-panel]');
      if (zone?.dataset.zoneAxis !== 'width') return null;
      const size = Number(zone.dataset.zoneSize);
      return size > 0 ? size : null;
    };
    let inset: number | null = null;
    let pinned = false;
    const unpin = () => {
      if (!pinned) return;
      pinned = false;
      node.style.removeProperty('width');
      node.style.removeProperty('min-width');
      node.style.removeProperty('will-change');
    };
    const measureAtRest = () => {
      unpin();
      const width = node.clientWidth;
      const size = zoneSize();
      if (width > 0 && size !== null) inset = size - width;
      setPanelWidth(width);
    };
    const applyTarget = () => {
      const size = zoneSize();
      if (size !== null && inset !== null) {
        const target = Math.max(0, size - inset);
        const width = `${target}px`;
        if (node.style.width !== width) {
          node.style.width = width;
          node.style.minWidth = width;
          node.style.willChange = 'transform';
          pinned = true;
        }
        setPanelWidth(target);
      }
      runWhenLayoutSettled(measureAtRest);
    };
    if (isLayoutAnimating()) runWhenLayoutSettled(measureAtRest);
    else measureAtRest();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (isLayoutAnimating()) applyTarget();
      else measureAtRest();
    });
    observer?.observe(node);
    const sizeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
      if (!isLayoutAnimating()) return;
      if (records.some((record) => record.target instanceof Node && record.target.contains(node))) applyTarget();
    });
    sizeObserver?.observe(node.ownerDocument.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-zone-size'] });
    const stopListening = onLayoutAnimationStart(applyTarget);
    releaseRootRef.current = () => {
      observer?.disconnect();
      sizeObserver?.disconnect();
      stopListening();
      cancelWhenLayoutSettled(measureAtRest);
      unpin();
    };
  }, [setPanelWidth]);

  const isWide = !isMobile && wideByWidth;

  const [expandedWorkingKeys, setExpandedWorkingKeys] = React.useState<Set<string>>(() => new Set());
  const [selectedWorkingEntry, setSelectedWorkingEntry] = React.useState<WorkingEntrySelection | null>(null);
  const [focusRequest, setFocusRequest] = React.useState<WorkingFocusRequest | null>(null);

  const [prevTargetFilePath, setPrevTargetFilePath] = React.useState<string | null>(null);
  if (isActive && targetFilePath && prevTargetFilePath !== targetFilePath) {
    setPrevTargetFilePath(targetFilePath);
    setFocusRequest((previous) => ({ path: targetFilePath, staged: diffScope === 'staged', nonce: (previous?.nonce ?? 0) + 1 }));
  }

  React.useEffect(() => {
    if (!isActive || !pendingTurnDiffFile || activeScope === 'turn') return;
    handleScopeChange('turn');
  }, [activeScope, handleScopeChange, isActive, pendingTurnDiffFile]);

  React.useEffect(() => {
    if (!isActive || (!pendingDiffFile && !pendingDiffScope)) return;
    const scope = normalizeScope(pendingDiffScope);
    if (pendingDiffScope && scope !== activeScope) handleScopeChange(scope);
    if (pendingDiffFile) {
      const staged = pendingDiffScope === 'staged' || pendingDiffStaged;
      setFocusRequest((previous) => ({ path: pendingDiffFile, staged, nonce: (previous?.nonce ?? 0) + 1 }));
    }
    clearPendingDiff();
  }, [activeScope, handleScopeChange, isActive, pendingDiffFile, pendingDiffScope, pendingDiffStaged]);

  const handleToggleWorkingEntryExpanded = React.useCallback((key: string, expanded: boolean) => {
    setExpandedWorkingKeys((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  return {
    activeScope,
    handleScopeChange,
    setRootRef,
    isWide,
    expandedWorkingKeys,
    setExpandedWorkingKeys,
    handleToggleWorkingEntryExpanded,
    selectedWorkingEntry,
    setSelectedWorkingEntry,
    focusRequest,
  };
}
