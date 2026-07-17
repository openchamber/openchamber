import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import type { SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';
import type { ContextPanelMode, ContextPanelTab } from '@/stores/useUIStore';

// Non-component shared helpers for the Side Panel (legacy ContextPanel + tiled TabGroupRegion/TiledPanel).
// Kept out of ContextPanel.tsx so that file only exports React components (react-refresh rule).

export const CONTEXT_PANEL_MIN_WIDTH = 380;
// Per-tile floors for tiled split regions; tiling uses these as allotment minSize
// along the split axis (width for horizontal splits, height for vertical).
export const CONTEXT_TILE_MIN_WIDTH = 300;
export const CONTEXT_TILE_MIN_HEIGHT = 120;
export const CONTEXT_PANEL_MAX_WIDTH = 1400;
export const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
export const CONTEXT_TAB_LABEL_MAX_CHARS = 24;

export type TranslateFn = ReturnType<typeof useI18n>['t'];

export const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

export const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

export const clampWidthToAvailableSpace = (width: number, panel: HTMLElement | null): number => {
  const clampedWidth = clampWidth(width);
  const availableWidth = getAvailablePanelWidth(panel);
  if (availableWidth === null) {
    return clampedWidth;
  }

  return Math.min(clampedWidth, Math.max(1, availableWidth));
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (mode: ContextPanelMode, t: TranslateFn): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'preview') return t('contextPanel.mode.preview');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; stagedDiff?: boolean },
  t: TranslateFn,
): string => {
  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'preview') {
    const url = tab.targetPath;
    if (url) {
      try {
        const parsed = new URL(url);
        return parsed.host || parsed.hostname || t('contextPanel.mode.preview');
      } catch {
        // ignore invalid URL
      }
    }
    return t('contextPanel.mode.preview');
  }

  if (tab.mode === 'diff') {
    return tab.stagedDiff ? t('contextPanel.mode.stagedDiff') : t('contextPanel.mode.workingDiff');
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { mode: ContextPanelMode; targetPath: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <Icon name="arrow-left-right" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <Icon name="file-text" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <Icon name="global" className="h-3.5 w-3.5 text-[var(--status-info)]" />;
  }

  if (tab.mode === 'browser') {
    return <Icon name="global" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

// Shared by ContextPanel + tiled TabGroupRegion so tab label/icon/tooltip stay identical.
export const buildContextTabItems = (
  tabs: ContextPanelTab[],
  t: TranslateFn,
  effectiveDirectory: string,
): SortableTabsStripItem[] => tabs.map((tab) => {
  const rawLabel = getTabLabel(tab, t);
  const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
  const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
  return {
    id: tab.id,
    label,
    icon: getTabIcon(tab),
    title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
    closeLabel: t('contextPanel.tab.closeTabAria', { label }),
  };
});
