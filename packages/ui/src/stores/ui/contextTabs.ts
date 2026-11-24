import { isVSCodeRuntime } from '@/lib/desktop';
import { isContextPanelMode } from '@/lib/surfaces/modes';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { CONTEXT_ZONE_DEFAULT_WIDTH } from '@/lib/workspace/zones';
import type { ContextZone } from '@/lib/workspace/zones';
import type { PendingDiffScope, ContextPanelTab, ContextPanelTabDescriptor } from './types';

const CONTEXT_PANEL_MIN_WIDTH = 320;

const CONTEXT_PANEL_DEFAULT_HEIGHT = 320;

const CONTEXT_PANEL_MIN_HEIGHT = 160;

const CONTEXT_PANEL_MAX_PERSISTED_WIDTH = 10000;

export const CONTEXT_PANEL_MAX_TABS = 12;

const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;

export const normalizeContextPanelDirectoryKey = (value: string): string => normalizeDirectoryPath(value);

export const normalizeDirectoryPath = (value: string): string => {
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

const clampContextPanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_ZONE_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_PERSISTED_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const clampContextPanelHeight = (height: number): number => {
  if (!Number.isFinite(height)) {
    return CONTEXT_PANEL_DEFAULT_HEIGHT;
  }

  return Math.min(CONTEXT_PANEL_MAX_PERSISTED_WIDTH, Math.max(CONTEXT_PANEL_MIN_HEIGHT, Math.round(height)));
};

export const clampContextZoneSize = (zone: ContextZone, pixels: number): number => (
  zone === 'bottom' ? clampContextPanelHeight(pixels) : clampContextPanelWidth(pixels)
);

export const normalizeContextTargetPath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const path = /^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) ? value : trimmed;
  return path.replace(/\\/g, '/');
};

export const normalizeContextTargetDirectory = (value: string | null | undefined): string | null => {
  const normalizedPath = normalizeContextTargetPath(value);
  if (!normalizedPath) {
    return null;
  }

  return normalizeContextPanelDirectoryKey(normalizedPath) || null;
};

export const contextPanelModeKeepsTargetDirectory = (mode: ContextPanelMode): boolean => {
  return mode === 'terminal' || mode === 'chat' || mode === 'pr' || mode === 'diff' || mode === 'walkthrough';
};

export const isTrackerBranchTab = (tab: { mode: ContextPanelMode; targetPath: string | null }): boolean => (
  tab.mode === 'pr' && !tab.targetPath
);

const normalizeContextTabLabel = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > CONTEXT_PANEL_MAX_LABEL_LENGTH
    ? trimmed.slice(0, CONTEXT_PANEL_MAX_LABEL_LENGTH)
    : trimmed;
};

export const normalizePendingDiffScope = (value: unknown): PendingDiffScope | null => {
  return value === 'working' || value === 'staged' || value === 'turn' || value === 'branch' || value === 'commit' || value === 'pr' ? value : null;
};

const buildDefaultContextPanelTabDedupeKey = (mode: ContextPanelMode, targetPath: string | null): string => {
  if (mode === 'file') {
    return targetPath || mode;
  }

  if (mode === 'browser' || mode === 'pr') {
    return targetPath || mode;
  }

  return mode;
};

const normalizeContextPanelTabDedupeKey = (
  mode: ContextPanelMode,
  targetPath: string | null,
  dedupeKey: string | null | undefined,
): string => {
  if (mode === 'diff' || mode === 'git') {
    return mode;
  }

  if (mode === 'file' && dedupeKey === targetPath && targetPath) return targetPath;

  if (typeof dedupeKey === 'string') {
    const trimmed = dedupeKey.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return buildDefaultContextPanelTabDedupeKey(mode, targetPath);
};

export const buildContextPanelTabID = (mode: ContextPanelMode, dedupeKey: string): string => {
  return dedupeKey === mode ? mode : `${mode}:${dedupeKey}`;
};

const normalizeBrowserTabOwner = (mode: ContextPanelMode, value: string | null | undefined): string | null => (
  mode === 'browser' && value?.trim() ? value.trim() : null
);

export const createContextPanelTab = (descriptor: ContextPanelTabDescriptor): ContextPanelTab => {
  const normalizedTargetPath = normalizeContextTargetPath(descriptor.targetPath);
  const normalizedTargetDirectory = contextPanelModeKeepsTargetDirectory(descriptor.mode)
    ? normalizeContextTargetDirectory(descriptor.targetDirectory)
    : null;
  const dedupeKey = normalizeContextPanelTabDedupeKey(
    descriptor.mode,
    normalizedTargetPath,
    descriptor.dedupeKey,
  );
  return {
    id: buildContextPanelTabID(descriptor.mode, dedupeKey),
    mode: descriptor.mode,
    targetPath: normalizedTargetPath,
    targetDirectory: normalizedTargetDirectory,
    dedupeKey,
    label: normalizeContextTabLabel(descriptor.label),
    sessionTitleFallback: normalizeContextTabLabel(descriptor.sessionTitleFallback),
    readOnly: descriptor.readOnly === true,
    stagedDiff: descriptor.stagedDiff === true,
    diffScope: normalizePendingDiffScope(descriptor.diffScope) ?? (descriptor.stagedDiff === true ? 'staged' : null),
    preview: descriptor.mode === 'file' && descriptor.preview === true,
    ownerSessionId: normalizeBrowserTabOwner(descriptor.mode, descriptor.ownerSessionId),
    touchedAt: Date.now(),
  };
};

export const clampContextPanelTabs = (
  tabs: ContextPanelTab[],
  maxTabsPerMode: number,
  activeTabId: string | null,
): ContextPanelTab[] => {
  const counts = new Map<ContextPanelMode, number>();
  for (const tab of tabs) counts.set(tab.mode, (counts.get(tab.mode) ?? 0) + 1);
  const over = [...counts.entries()].filter(([, count]) => count > maxTabsPerMode);
  if (over.length === 0) return tabs;

  const removeSet = new Set<string>();
  for (const [mode, count] of over) {
    const modeTabs = tabs.filter((tab) => tab.mode === mode);
    const removable = [...modeTabs]
      .sort((a, b) => a.touchedAt - b.touchedAt)
      .filter((tab) => tab.id !== activeTabId && !isTrackerBranchTab(tab));
    for (const tab of removable.slice(0, count - maxTabsPerMode)) removeSet.add(tab.id);
  }

  return removeSet.size === 0 ? tabs : tabs.filter((tab) => !removeSet.has(tab.id));
};

export const sanitizeContextPanelTabs = (tabs: unknown): ContextPanelTab[] => {
  if (!Array.isArray(tabs)) {
    return [];
  }
  const dropBrowserTabs = isVSCodeRuntime();

  const result: ContextPanelTab[] = [];
  const seen = new Set<string>();

  for (const entry of tabs) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const candidate = entry as {
      mode?: unknown;
      targetPath?: unknown;
      targetDirectory?: string | null;
      dedupeKey?: unknown;
      label?: unknown;
      sessionTitleFallback?: unknown;
      readOnly?: unknown;
      stagedDiff?: unknown;
      diffScope?: unknown;
      preview?: unknown;
      ownerSessionId?: unknown;
      touchedAt?: unknown;
    };

    if (typeof candidate.mode !== 'string' || !isContextPanelMode(candidate.mode)) {
      continue;
    }

    if (dropBrowserTabs && candidate.mode === 'browser') {
      continue;
    }

    const targetPath = normalizeContextTargetPath(typeof candidate.targetPath === 'string' ? candidate.targetPath : null);
    const targetDirectory = contextPanelModeKeepsTargetDirectory(candidate.mode)
      ? normalizeContextTargetDirectory(candidate.targetDirectory)
      : null;
    const mode: ContextPanelMode = candidate.mode === 'diff' && !targetDirectory ? 'git' : candidate.mode;
    const dedupeKey = normalizeContextPanelTabDedupeKey(
      mode,
      targetPath,
      typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
    );
    const id = buildContextPanelTabID(mode, dedupeKey);
    const replacesPlainGit = mode !== candidate.mode && seen.has(id);
    if (!id || (seen.has(id) && !replacesPlainGit)) {
      continue;
    }

    seen.add(id);
    const slot = replacesPlainGit ? result.findIndex((tab) => tab.id === id) : result.length;
    result[slot] = {
      id,
      mode,
      targetPath,
      targetDirectory,
      dedupeKey,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
      sessionTitleFallback: normalizeContextTabLabel(typeof candidate.sessionTitleFallback === 'string' ? candidate.sessionTitleFallback : null),
      readOnly: candidate.readOnly === true,
      stagedDiff: candidate.stagedDiff === true,
      diffScope: normalizePendingDiffScope(candidate.diffScope) ?? (candidate.stagedDiff === true ? 'staged' : null),
      preview: mode === 'file' && candidate.preview === true,
      ownerSessionId: normalizeBrowserTabOwner(
        mode,
        typeof candidate.ownerSessionId === 'string' ? candidate.ownerSessionId : null,
      ),
      touchedAt: typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
        ? candidate.touchedAt
        : Date.now(),
    };
  }

  return result;
};

export const migrateLegacyContextTabId = (id: string | null, tabs: readonly ContextPanelTab[]): string | null => (
  id === 'diff' && !tabs.some((tab) => tab.id === 'diff') && tabs.some((tab) => tab.id === 'git') ? 'git' : id
);

export const resolveActiveContextPanelTabID = (tabs: ContextPanelTab[], activeTabId: string | null): string | null => {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  if (tabs.length === 0) {
    return null;
  }

  return tabs[tabs.length - 1].id;
};
