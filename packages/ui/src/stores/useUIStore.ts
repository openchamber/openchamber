import { create } from 'zustand';
import { DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS, isSessionGoalMaxAutoTurns } from '@/lib/sessionGoalTurnLimit';
import { z } from 'zod';
import { devtools, persist } from 'zustand/middleware';
import type { SidebarSection } from '@/constants/sidebar';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { EMPTY_NOTIFICATION_TEMPLATES, isLegacyDefaultTemplates } from './utils/notificationTemplates';
import { SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '@/lib/typography';
import type { ShortcutCombo } from '@/lib/shortcuts';
import type { DraftStarterRef } from '@/lib/draftStarters';
import type { CustomProviderIcon } from '@/lib/customProviderIcons';
import type { CustomProviderLogo } from '@/lib/customProviderLogos';
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, DEFAULT_UI_FONT_WEIGHT, type MonoFontOption, type UiFontOption, type UiFontWeight } from '@/lib/fontOptions';
import { getStoredMobileKeyboardMode, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { TerminalShell } from '@/lib/api/types';
import type { PermissionMode } from './utils/permissionAutoAccept';
import { directoryMayHaveActiveProjectAction, useTerminalStore } from '@/stores/useTerminalStore';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { rebaseMovedPath } from '@/lib/filePathMoves';
import { isVSCodeRuntime } from '@/lib/desktop';
import { noteBrowserTabOpenedWithAddress, requestBrowserTabLoad } from '@/lib/browser/devServerWait';
import { clampLiveBrowserTabs, LIVE_BROWSER_TABS_DEFAULT } from '@/lib/browser/liveTabs';
import { isContextPanelMode, type ContextPanelMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder, type MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import {
  carrySurfaceToZone,
  getZoneView,
  resolveZoneActiveTabId,
  keepZoneViewsOnTabs,
  zonePlacementSchema,
  zoneViewsSchema,
  settleZones,
  withZoneView,
  zoneOfMode,
  CLOSED_ZONE_VIEW,
  CONTEXT_ZONE_DEFAULT_WIDTH,
  CONTEXT_ZONES,
  type ContextZone,
  type ContextZonePlacement,
  type ContextZoneView,
  type MovedZoneViews,
} from '@/lib/workspace/zones';
import { sanitizeWorkStatusSectionOrder, type WorkStatusPanelSectionId } from '@/components/chat/work-status/sections';

export type PendingDiffScope = 'working' | 'staged' | 'turn' | 'branch' | 'commit' | 'pr';
export type { ContextPanelMode };

export const clampContextEditorTreeWidth = (width: number): number =>
  Math.min(480, Math.max(200, Math.round(width)));

const persistedPixelsSchema = z.number().finite().optional().catch(undefined);
const persistedZoneSizesSchema = z.object({
  sizeByZone: z.object({
    left: persistedPixelsSchema,
    right: persistedPixelsSchema,
    bottom: persistedPixelsSchema,
  }).optional().catch(undefined),
  widthByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
  heightByMode: z.record(z.string(), persistedPixelsSchema).catch({}),
});
type MermaidRenderingMode = 'svg' | 'ascii';
type UserMessageRenderingMode = 'markdown' | 'plain';
type ActivityRenderMode = 'collapsed' | 'summary';
export type SessionRetentionAction = 'archive' | 'delete';
export type TimeFormatPreference = 'auto' | '12h' | '24h';
type WeekStartPreference = 'auto' | 'sunday' | 'monday';
type DesktopWindowControlsPosition = 'left' | 'right';
type DesktopWindowControlsStyle = 'classic' | 'traffic-lights';
export type MobileKeepScreenAwake = 'off' | 'working' | 'always';
export type FileEditorKeymap = 'default' | 'vim';
export type LargeTextPasteBehavior = 'ask' | 'attach' | 'inline' | 'inline-double-paste';
export type ChatWidth = 'default' | 'wider' | 'full';
export type SessionGoalChecker = 'classifier' | 'small-model';

const DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR: LargeTextPasteBehavior = 'ask';

const normalizeLargeTextPasteBehavior = (value: unknown): LargeTextPasteBehavior => {
  if (value === 'attach' || value === 'inline' || value === 'ask' || value === 'inline-double-paste') {
    return value;
  }
  return DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR;
};

function normalizeFileEditorKeymap(value: unknown): FileEditorKeymap {
  return value === 'vim' ? 'vim' : 'default';
}

type ContextPanelTab = {
  id: string;
  mode: ContextPanelMode;
  targetPath: string | null;
  targetDirectory: string | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: PendingDiffScope | null;
  preview: boolean;
  ownerSessionId: string | null;
  touchedAt: number;
};

type ContextPanelTabDescriptor = {
  mode: ContextPanelMode;
  targetPath?: string | null;
  targetDirectory?: string | null;
  dedupeKey?: string | null;
  label?: string | null;
  sessionTitleFallback?: string | null;
  readOnly?: boolean;
  stagedDiff?: boolean;
  diffScope?: PendingDiffScope | null;
  preview?: boolean;
  ownerSessionId?: string | null;
};

type ContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  tabs: ContextPanelTab[];
  activeTabId: string | null;
  zones: MovedZoneViews;
  touchedAt: number;
};

type PendingFileNavigation = {
  path: string;
  line: number;
  column: number;
};

type EventStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'paused'
  | 'offline'
  | 'error';

const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_DEFAULT_HEIGHT = 320;
const CONTEXT_PANEL_MIN_HEIGHT = 160;
const CONTEXT_PANEL_MAX_PERSISTED_WIDTH = 10000;
const CONTEXT_PANEL_MAX_TABS = 12;
const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;
const MAX_LAST_USED_EFFORTS = 512;
const LEFT_SIDEBAR_DEFAULT_WIDTH = 280;
let browserTabSequence = 0;

export const normalizeContextPanelDirectoryKey = (value: string): string => normalizeDirectoryPath(value);

const normalizeDirectoryPath = (value: string): string => {
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

const clampContextZoneSize = (zone: ContextZone, pixels: number): number => (
  zone === 'bottom' ? clampContextPanelHeight(pixels) : clampContextPanelWidth(pixels)
);

const normalizeContextTargetPath = (value: string | null | undefined): string | null => {
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

const normalizeContextTargetDirectory = (value: string | null | undefined): string | null => {
  const normalizedPath = normalizeContextTargetPath(value);
  if (!normalizedPath) {
    return null;
  }

  return normalizeContextPanelDirectoryKey(normalizedPath) || null;
};

const contextPanelModeKeepsTargetDirectory = (mode: ContextPanelMode): boolean => {
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

const normalizePendingDiffScope = (value: unknown): PendingDiffScope | null => {
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
  if (mode === 'diff') {
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

const buildContextPanelTabID = (mode: ContextPanelMode, dedupeKey: string): string => {
  return dedupeKey === mode ? mode : `${mode}:${dedupeKey}`;
};

const normalizeBrowserTabOwner = (mode: ContextPanelMode, value: string | null | undefined): string | null => (
  mode === 'browser' && value?.trim() ? value.trim() : null
);

const createContextPanelTab = (descriptor: ContextPanelTabDescriptor): ContextPanelTab => {
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

const clampContextPanelTabs = (
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

const sanitizeContextPanelTabs = (tabs: unknown): ContextPanelTab[] => {
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
    const dedupeKey = normalizeContextPanelTabDedupeKey(
      candidate.mode,
      targetPath,
      typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
    );
    const id = buildContextPanelTabID(candidate.mode, dedupeKey);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push({
      id,
      mode: candidate.mode,
      targetPath,
      targetDirectory,
      dedupeKey,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
      sessionTitleFallback: normalizeContextTabLabel(typeof candidate.sessionTitleFallback === 'string' ? candidate.sessionTitleFallback : null),
      readOnly: candidate.readOnly === true,
      stagedDiff: candidate.stagedDiff === true,
      diffScope: normalizePendingDiffScope(candidate.diffScope) ?? (candidate.stagedDiff === true ? 'staged' : null),
      preview: candidate.mode === 'file' && candidate.preview === true,
      ownerSessionId: normalizeBrowserTabOwner(
        candidate.mode,
        typeof candidate.ownerSessionId === 'string' ? candidate.ownerSessionId : null,
      ),
      touchedAt: typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
        ? candidate.touchedAt
        : Date.now(),
    });
  }

  return result;
};

const resolveActiveContextPanelTabID = (tabs: ContextPanelTab[], activeTabId: string | null): string | null => {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  if (tabs.length === 0) {
    return null;
  }

  return tabs[tabs.length - 1].id;
};

const touchContextPanelState = (
  prev: ContextPanelDirectoryState | undefined,
  placement: ContextZonePlacement,
): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    return settleZones({
      ...prev,
      tabs,
      zones: keepZoneViewsOnTabs(zoneViewsSchema.parse(prev.zones), new Set(tabs.map((tab) => tab.id))),
      touchedAt: Date.now(),
    }, placement);
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    zones: { left: CLOSED_ZONE_VIEW, bottom: CLOSED_ZONE_VIEW },
    touchedAt: Date.now(),
  };
};

const noteBrowserTabAddressRequested = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  directory: string,
  dedupeKey: string,
  url: string,
): void => {
  const tabID = buildContextPanelTabID('browser', dedupeKey);
  if (byDirectory[directory]?.tabs.some((tab) => tab.id === tabID)) {
    requestBrowserTabLoad(directory, tabID, url);
    return;
  }
  noteBrowserTabOpenedWithAddress(directory, tabID);
};

const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
  placement: ContextZonePlacement,
  options?: { reveal?: boolean },
): ContextPanelDirectoryState => {
  const reveal = options?.reveal !== false;
  const nextTab = createContextPanelTab(descriptor);
  const baseTabs = nextTab.mode === 'file' && nextTab.targetPath
    ? current.tabs.filter((tab) => !(tab.mode === 'file' && !tab.targetPath))
    : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  const replacedPreviewIndex = existingIndex === -1 && nextTab.preview
    ? baseTabs.findIndex((tab) => tab.preview)
    : -1;
  const tabs = replacedPreviewIndex !== -1
    ? baseTabs.map((tab, index) => (index === replacedPreviewIndex ? nextTab : tab))
    : existingIndex === -1
    ? [...baseTabs, nextTab]
    : baseTabs.map((tab, index) => (index === existingIndex
      ? {
          ...tab,
          mode: nextTab.mode,
          targetPath: nextTab.targetPath || tab.targetPath,
          targetDirectory: nextTab.targetDirectory,
          dedupeKey: nextTab.dedupeKey,
          label: nextTab.label,
          sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
          stagedDiff: nextTab.stagedDiff,
          diffScope: nextTab.diffScope,
          readOnly: nextTab.readOnly,
          preview: tab.preview && nextTab.preview,
          touchedAt: Date.now(),
        }
      : tab));

  const zone = zoneOfMode(placement, nextTab.mode);
  const view = getZoneView(current, zone);
  const activeTabId = reveal
    ? nextTab.id
    : resolveZoneActiveTabId(current.tabs, placement, zone, view.activeTabId) ?? nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return settleZones(withZoneView({
    ...current,
    tabs: clampedTabs,
    touchedAt: Date.now(),
  }, zone, {
    isOpen: reveal ? true : view.isOpen,
    activeTabId,
  }), placement);
};

const closeContextPanelTabs = (
  current: ContextPanelDirectoryState,
  tabIds: readonly string[],
  placement: ContextZonePlacement,
): ContextPanelDirectoryState => {
  const closed = new Set(tabIds);
  const closedTabs = current.tabs.filter((tab) => closed.has(tab.id));
  let nextTabs = current.tabs.filter((tab) => !closed.has(tab.id));
  if (nextTabs.length === current.tabs.length) {
    return current;
  }

  const views: Partial<Record<ContextZone, Partial<ContextZoneView>>> = {};
  for (const zone of CONTEXT_ZONES) {
    const view = getZoneView(current, zone);
    const activeClosed = view.activeTabId ? closed.has(view.activeTabId) : false;
    if (!activeClosed) continue;

    const activeMode = closedTabs.find((tab) => tab.id === view.activeTabId)?.mode ?? null;
    const sameModeTabs = activeMode ? nextTabs.filter((tab) => tab.mode === activeMode) : [];
    const nextSameModeTab = sameModeTabs.length > 0
      ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
      : null;

    if (activeMode === 'file' && !nextSameModeTab && closedTabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      const placeholder = createContextPanelTab({ mode: 'file' });
      nextTabs = [...nextTabs, placeholder];
      views[zone] = { activeTabId: placeholder.id };
      continue;
    }

    views[zone] = nextSameModeTab
      ? { activeTabId: nextSameModeTab.id }
      : { activeTabId: null, isOpen: false, expanded: false };
  }

  let next: ContextPanelDirectoryState = { ...current, tabs: nextTabs, touchedAt: Date.now() };
  for (const zone of CONTEXT_ZONES) {
    const patch = views[zone];
    if (patch) next = withZoneView(next, zone, patch);
  }
  return settleZones(next, placement);
};

const reorderContextPanelTabs = (
  current: ContextPanelDirectoryState,
  activeTabID: string,
  overTabID: string,
): ContextPanelDirectoryState => {
  if (activeTabID === overTabID) {
    return current;
  }

  const fromIndex = current.tabs.findIndex((tab) => tab.id === activeTabID);
  const toIndex = current.tabs.findIndex((tab) => tab.id === overTabID);
  if (fromIndex === -1 || toIndex === -1) {
    return current;
  }

  const tabs = [...current.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return current;
  }

  tabs.splice(toIndex, 0, moved);

  return {
    ...current,
    tabs,
    touchedAt: Date.now(),
  };
};

const setContextPanelTabTargetPath = (
  current: ContextPanelDirectoryState,
  tabID: string,
  targetPath: string,
): ContextPanelDirectoryState => ({
  ...current,
  tabs: current.tabs.map((tab) =>
    tab.id === tabID ? { ...tab, targetPath } : tab,
  ),
});

const moveContextPanelFileTabs = (
  current: ContextPanelDirectoryState,
  fromPath: string,
  toPath: string,
): ContextPanelDirectoryState => {
  const renamed = new Map<string, string>();
  const movedIds = new Set<string>();
  const tabs = current.tabs.map((tab) => {
    if (tab.mode !== 'file' || !tab.targetPath) return tab;
    const targetPath = rebaseMovedPath(tab.targetPath, fromPath, toPath);
    if (targetPath === null) return tab;
    const keyFollowsPath = tab.dedupeKey === tab.targetPath;
    const dedupeKey = keyFollowsPath ? targetPath : tab.dedupeKey;
    const id = keyFollowsPath ? buildContextPanelTabID(tab.mode, dedupeKey) : tab.id;
    renamed.set(tab.id, id);
    movedIds.add(id);
    return { ...tab, targetPath, dedupeKey, id };
  });
  if (movedIds.size === 0) return current;

  let next: ContextPanelDirectoryState = {
    ...current,
    tabs: tabs.filter((tab, index) => tab !== current.tabs[index] || !movedIds.has(tab.id)),
    touchedAt: Date.now(),
  };
  for (const zone of CONTEXT_ZONES) {
    const activeTabId = getZoneView(current, zone).activeTabId;
    const renamedId = activeTabId ? renamed.get(activeTabId) : undefined;
    if (renamedId) next = withZoneView(next, zone, { activeTabId: renamedId });
  }
  return next;
};

const withoutForeignComparisons = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
): Record<string, ContextPanelDirectoryState> => {
  const isForeign = (tab: ContextPanelTab) => (tab.mode === 'diff' || tab.mode === 'walkthrough') && tab.targetDirectory !== null;
  if (!Object.values(byDirectory).some((panel) => panel.tabs.some(isForeign))) return byDirectory;
  return Object.fromEntries(Object.entries(byDirectory).map(([directory, panel]) => [directory, panel.tabs.some(isForeign)
    ? { ...panel, tabs: panel.tabs.map((tab) => (isForeign(tab) ? { ...tab, targetDirectory: null } : tab)) }
    : panel]));
};

type LegacyZoneSizes = { sizes: Partial<Record<ContextZone, number>>; touchedAt: number };

const sanitizeContextPanelByDirectory = (
  value: unknown,
  legacySizes?: LegacyZoneSizes[],
): Record<string, ContextPanelDirectoryState> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, ContextPanelDirectoryState> = {};

  for (const [rawDirectory, rawState] of Object.entries(source)) {
    const directory = normalizeDirectoryPath(rawDirectory);
    if (!directory || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const candidate = rawState as {
      isOpen?: unknown;
      expanded?: unknown;
      zones?: unknown;
      tabs?: unknown;
      activeTabId?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      targetDirectory?: string | null;
      dedupeKey?: unknown;
      label?: unknown;
    };

    let tabs = sanitizeContextPanelTabs(candidate.tabs);
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

    if (tabs.length === 0 && (candidate.mode === 'diff' || candidate.mode === 'file' || candidate.mode === 'context' || candidate.mode === 'chat' || candidate.mode === 'terminal')) {
      tabs = [createContextPanelTab({
        mode: candidate.mode,
        targetPath: typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
        targetDirectory: candidate.targetDirectory,
        dedupeKey: typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
        label: typeof candidate.label === 'string' ? candidate.label : null,
      })];
      activeTabId = tabs[0]?.id ?? null;
    }

    const resolvedActiveTabId = resolveActiveContextPanelTabID(tabs, activeTabId);
    const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, resolvedActiveTabId);

    const resolvedTabId = resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId);
    const zones = keepZoneViewsOnTabs(zoneViewsSchema.parse(candidate.zones), new Set(clampedTabs.map((tab) => tab.id)));
    const touchedAt = typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
      ? candidate.touchedAt
      : Date.now();
    if (legacySizes) {
      const savedSizes = persistedZoneSizesSchema.parse(rawState);
      const sizes: Partial<Record<ContextZone, number>> = {};
      for (const zone of CONTEXT_ZONES) {
        let pixels = savedSizes.sizeByZone?.[zone];
        if (!savedSizes.sizeByZone) {
          const zoneTabId = zone === 'right' ? resolvedTabId : zones[zone].activeTabId;
          const mode = clampedTabs.find((tab) => tab.id === zoneTabId)?.mode;
          pixels = mode ? (zone === 'bottom' ? savedSizes.heightByMode : savedSizes.widthByMode)[mode] : undefined;
        }
        if (pixels !== undefined) sizes[zone] = clampContextZoneSize(zone, pixels);
      }
      legacySizes.push({ sizes, touchedAt });
    }

    next[directory] = {
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolvedTabId,
      zones,
      touchedAt,
    };
  }

  return next;
};

const clampContextPanelRoots = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  maxRoots: number
): Record<string, ContextPanelDirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) {
    return byDirectory;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, ContextPanelDirectoryState> = {};
  for (const [directory, state] of entries.slice(0, maxRoots)) {
    next[directory] = state;
  }
  return next;
};

interface UIStore {

  theme: 'light' | 'dark' | 'system';
  runOverviewKey: string | null;
  parallelComposerRequest: { id: number; prompt: string } | null;
  isSidebarOpen: boolean;
  sidebarFoldedForExpandedZone: boolean;
  sidebarWidth: number;
  contextPanelByDirectory: Record<string, ContextPanelDirectoryState>;
  contextRailOrder: string[];
  contextRailHiddenSurfaces: string[];
  mobileWorkspaceTabOrder: string[];
  mobileWorkspaceHiddenTabs: string[];
  mobileWorkStatusHiddenSections: string[];
  contextSurfaceZones: ContextZonePlacement;
  contextEditorTreeVisible: boolean;
  fileTreeSide: 'left' | 'right';
  contextEditorVisible: boolean;
  contextEditorTreeWidth: number;
  contextZoneSizes: Partial<Record<ContextZone, number>>;
  contextZoneExpandedChatSizes: Partial<Record<ContextZone, number>>;
  workStatusExpandedSections: Record<string, boolean>;
  messageQueueExpanded: boolean;
  workStatusScrollTop: number;
  workStatusPanelEnabled: boolean;
  workStatusPanelVisible: boolean;
  workStatusPanelFits: boolean;
  workStatusOverlayOpen: boolean;
  workStatusHiddenSections: string[];
  workStatusSectionOrder: WorkStatusPanelSectionId[];
  workStatusSectionOrderExplicit: boolean;
  workStatusHiddenSectionsExplicit: boolean;
  isSessionSwitcherOpen: boolean;
  isSessionDropdownOpen: boolean;
  pendingDiffFile: string | null;
  pendingDiffStaged: boolean;
  pendingDiffScope: PendingDiffScope | null;
  pendingTurnDiffFile: { file: string; sessionId: string | null } | null;
  pendingFileNavigation: PendingFileNavigation | null;
  pendingFileFocusPath: string | null;
  isMobile: boolean;
  isCommandPaletteOpen: boolean;
  isHelpDialogOpen: boolean;
  isProjectActionsDialogOpen: boolean;
  isAboutDialogOpen: boolean;
  isOpenCodeStatusDialogOpen: boolean;
  openCodeStatusText: string;
  isSessionCreateDialogOpen: boolean;
  isScheduledTasksDialogOpen: boolean;
  isArchivePageOpen: boolean;
  isIntegrationsCatalogOpen: boolean;
  archivePageOpenCount: number;
  isUsageStatsPageOpen: boolean;
  isSourceBoardOpen: boolean;
  isOverviewOpen: boolean;
  openGuestPageId: string | null;
  worktreesPageProjectId: string | null;
  spacesPageProjectId: string | null;
  isSettingsDialogOpen: boolean;
  isNewWorktreeDialogOpen: boolean;
  isModelSelectorOpen: boolean;
  sidebarSection: SidebarSection;

  settingsPage: string;
  settingsHasOpenedOnce: boolean;
  settingsProjectsSelectedId: string | null;
  settingsProjectPath: string | null;
  settingsProvidersConnectRequested: boolean;
  settingsProvidersClassificationRequested: boolean;
  settingsProvidersOpenRequested: string | null;
  settingsJumpRequest: { page: string; itemId: string | null } | null;
  settingsRemoteInstancesSelectedId: string | null;
  eventStreamStatus: EventStreamStatus;
  eventStreamHint: string | null;
  showReasoningTraces: boolean;
  streamingAutoFollowEnabled: boolean;
  sessionRecapEnabled: boolean;
  sessionSuggestionEnabled: boolean;
  sessionWorkEnabled: boolean;
  sessionReviewOfferEnabled: boolean;
  sessionGoalEnabled: boolean;
  sessionGoalChecker: SessionGoalChecker;
  sessionGoalMaxAutoTurns: number;
  sessionGoalDefaultBudgetEnabled: boolean;
  sessionGoalDefaultBudget: number;
  collapsibleThinkingBlocks: boolean;
  expandReasoningWhileStreaming: boolean;
  activityRenderMode: ActivityRenderMode;
  showDeletionDialog: boolean;
  autoDeleteEnabled: boolean;
  autoSaveEnabled: boolean;
  fileEditorWrapLines: boolean;
  confirmFileTreeMove: boolean;
  layoutAnimations: boolean;
  openLinksInBrowserPanel: boolean;
  liveBrowserTabLimit: number;
  agentBrowserSharesLogins: boolean;
  openTrackerLinksOnBoard: boolean;
  autoDeleteAfterDays: number;
  sessionRetentionAction: SessionRetentionAction;
  sessionRetentionOnlyArchived: boolean;
  sessionRetentionIncludeInWork: boolean;
  mergedWorktreeCleanupEnabled: boolean;
  worktreeArchiveOnDoneEnabled: boolean;
  autoDeleteLastRunAt: number | null;
  messageLimit: number;
  fontSize: number;
  chatFontSize: number;
  globalDraftStarters: DraftStarterRef[] | null;
  draftStartersVisible: boolean;
  terminalFontSize: number;
  terminalShell: TerminalShell;
  terminalLoginShells: TerminalShell[];
  terminalCloseOnExit: boolean;
  terminalOpenOnProjectAction: boolean;
  editorFontSize: number;
  uiFont: UiFontOption;
  monoFont: MonoFontOption;
  customUiFont: string;
  customMonoFont: string;
  uiFontWeight: UiFontWeight;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;
  mobileKeyboardMode: MobileKeyboardMode;

  favoriteModels: Array<{ providerID: string; modelID: string }>;
  hiddenModels: Array<{ providerID: string; modelID: string }>;
  providerOrder: string[];
  collapsedModelProviders: string[];
  customProviderIcons: Record<string, CustomProviderIcon>;
  customProviderLogos: Record<string, CustomProviderLogo>;
  recentModels: Array<{ providerID: string; modelID: string }>;
  lastSelectedModel: string | undefined;
  recentAgents: string[];
  favoriteAgents: string[];
  recentEfforts: Record<string, string[]>;
  lastUsedEfforts: Record<string, string | null>;

  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
  diffWrapLines: boolean;
  diffHideWhitespace: boolean;
  diffFileListMode: 'flat' | 'tree';
  diffFileTreeWidth: number;
  walkthroughTocWidth: number;
  gitChangesViewMode: 'flat' | 'tree';
  toolJsonViewMode: 'summary' | 'formatted' | 'raw';
  isTimelineDialogOpen: boolean;
  isPromptNavigatorPanelOpen: boolean;
  isImagePreviewOpen: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnSubtasks: boolean;
  dockBadgeEnabled: boolean;
  alwaysShowScrollbars: boolean;
  mobileKeepScreenAwake: MobileKeepScreenAwake;
  questionsInChat: boolean;

  notifyOnCompletion: boolean;
  notifyOnPullRequests: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;

  notificationTemplates: {
    completion: { title: string; message: string };
    error: { title: string; message: string };
    question: { title: string; message: string };
    subtask: { title: string; message: string };
  };

  summarizeLastMessage: boolean;
  summaryThreshold: number;
  summaryLength: number;
  maxLastMessageLength: number;

  showTerminalQuickKeysOnDesktop: boolean;
  sessionTabsEnabled: boolean;
  sessionTabsPerWorkspace: boolean;
  showOpenCodeUpdateNotifications: boolean;
  agentControlToolEnabled: boolean;
  agentScheduleToolEnabled: boolean;
  agentWebToolEnabled: boolean;
  messageSearchEnabled: boolean;
  messageSearchReasoningEnabled: boolean;
  browserProvider: string;
  agentMemoryToolEnabled: boolean;
  agentKnowledgeToolEnabled: boolean;
  agentNotifyToolEnabled: boolean;
  agentUsageToolEnabled: boolean;
  agentTerminalToolEnabled: boolean;
  agentImageToolEnabled: boolean;
  agentImageModel: string;
  agentMemoryDreamingEnabled: boolean;
  agentMemoryDreamingModel: string;
  agentMemoryDreamingVariant: string;
  agentRenderToolEnabled: boolean;
  agentSecretToolEnabled: boolean;
  agentWorkflowToolEnabled: boolean;
  agentWorkflowAutoApprove: boolean;
  isolatedSpacesEnabled: boolean;
  permissionDefaultMode: PermissionMode;
  agentMemoryFeatureAvailable: boolean;
  agentWorkflowFeatureAvailable: boolean;
  routingFeatureAvailable: boolean;
  overviewFeatureAvailable: boolean;
  agentMemoryViewedAt: Record<string, number>;
  projectContextTab: string;
  projectKnowledgePlanRequest: { projectContextId: string; planId: string } | null;
  inputSpellcheckEnabled: boolean;
  largeTextPasteBehavior: LargeTextPasteBehavior;
  enterToSend: boolean;
  enterToSendConfigured: boolean;
  mobileReturnKeySends: boolean;
  chatWidth: ChatWidth;
  codeBlockLineWrap: boolean;
  tableCellWrap: boolean;
  copyMessagesAsPlainText: boolean;
  selectionApprovalText: string;
  showToolFileIcons: boolean;
  showTurnChangedFiles: boolean;
  timeFormatPreference: TimeFormatPreference;
  weekStartPreference: WeekStartPreference;
  desktopWindowControlsPosition: DesktopWindowControlsPosition;
  desktopWindowControlsStyle: DesktopWindowControlsStyle;
  mermaidRenderingMode: MermaidRenderingMode;
  userMessageRenderingMode: UserMessageRenderingMode;
  collapsibleUserMessages: boolean;
  stickyUserHeader: boolean;
  promptNavigatorEnabled: boolean;
  showSplitAssistantMessageActions: boolean;
  allowPromptingSubagentSessions: boolean;
  savePastedImagesAsFiles: boolean;
  isExpandedInput: boolean;
  reportUsage: boolean;
  shortcutOverrides: Record<string, ShortcutCombo>;
  fileEditorKeymap: FileEditorKeymap;
  fileEditorVimMappings: string;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarFoldedForExpandedZone: (folded: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setContextRailOrder: (order: string[]) => void;
  toggleContextEditorTree: () => void;
  toggleContextEditor: () => void;
  setContextEditorTreeWidth: (width: number) => void;
  openContextSurface: (directory: string, mode: ContextPanelMode) => void;
  openContextPanelTab: (directory: string, tab: ContextPanelTabDescriptor, options?: { reveal?: boolean }) => void;
  openTrackerItem: (directory: string, item: { url: string; key: string; label: string; targetDirectory: string | null }) => string | null;
  openContextDiff: (directory: string, filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  openContextFile: (directory: string, filePath: string, options?: { preview?: boolean; expanded?: boolean }) => void;
  pinContextPanelTab: (directory: string, tabID: string) => void;
  openContextFileAtLine: (directory: string, filePath: string, line: number, column?: number, options?: { preview?: boolean }) => void;
  openContextOverview: (directory: string) => void;
  openContextPreview: (directory: string, url: string) => void;
  openContextBrowser: (directory: string, url?: string, options?: { reveal?: boolean }) => void;
  openNewContextBrowserTab: (directory: string) => void;
  openAgentBrowserTab: (directory: string, url: string, ownerSessionId: string | null) => string | null;
  setContextPanelTabTargetPath: (directory: string, tabID: string, targetPath: string) => void;
  moveContextFilePaths: (directory: string, fromPath: string, toPath: string, filesRoot?: string) => void;
  setActiveContextPanelTab: (directory: string, tabID: string) => void;
  reorderContextPanelTabs: (directory: string, activeTabID: string, overTabID: string) => void;
  closeContextPanelTab: (directory: string, tabID: string) => void;
  closeContextFile: (directory: string, filePath: string) => void;
  closeContextPanelTabs: (directory: string, tabIds: readonly string[]) => void;
  closeContextPanel: (directory: string) => void;
  closeContextZone: (directory: string, zone: ContextZone) => void;
  toggleContextPanelExpanded: (directory: string, zone?: ContextZone) => void;
  setContextZoneSize: (zone: ContextZone, size: number) => void;
  setContextZoneExpandedChatSize: (zone: ContextZone, size: number) => void;
  moveContextSurfaceToZone: (mode: ContextPanelMode, zone: ContextZone) => void;
  setWorkStatusSectionExpanded: (sectionId: string, expanded: boolean) => void;
  setMessageQueueExpanded: (expanded: boolean) => void;
  setWorkStatusScrollTop: (scrollTop: number) => void;
  setWorkStatusPanelEnabled: (enabled: boolean) => void;
  setWorkStatusPanelVisible: (visible: boolean) => void;
  setWorkStatusPanelFits: (fits: boolean) => void;
  setWorkStatusOverlayOpen: (open: boolean) => void;
  setWorkStatusSectionVisible: (sectionId: string, visible: boolean) => void;
  setWorkStatusHiddenSections: (sectionIds: string[]) => void;
  setWorkStatusSectionOrder: (sectionIds: readonly string[]) => void;
  setContextRailSurfaceVisible: (surfaceId: string, visible: boolean) => void;
  setContextRailHiddenSurfaces: (surfaceIds: string[]) => void;
  setMobileWorkspaceTabOrder: (order: readonly string[]) => void;
  setMobileWorkspaceTabVisible: (tab: MobileWorkspaceTab, visible: boolean, extensions?: readonly PluginContextPanelMode[]) => void;
  setMobileWorkStatusSectionVisible: (sectionId: string, visible: boolean) => void;
  setMobileWorkStatusHiddenSections: (sectionIds: string[]) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setSessionDropdownOpen: (open: boolean) => void;
  setPendingDiffFile: (filePath: string | null, staged?: boolean, scope?: PendingDiffScope | null) => void;
  setPendingTurnDiffFile: (request: { file: string; sessionId: string | null } | null) => void;
  setPendingFileNavigation: (navigation: PendingFileNavigation | null) => void;
  setPendingFileFocusPath: (path: string | null) => void;
  navigateToDiff: (filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  consumePendingDiffFile: () => string | null;
  setIsMobile: (isMobile: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleHelpDialog: () => void;
  setHelpDialogOpen: (open: boolean) => void;
  setProjectActionsDialogOpen: (open: boolean) => void;
  setAboutDialogOpen: (open: boolean) => void;
  setOpenCodeStatusDialogOpen: (open: boolean) => void;
  setOpenCodeStatusText: (text: string) => void;
  setSessionCreateDialogOpen: (open: boolean) => void;
  setScheduledTasksDialogOpen: (open: boolean) => void;
  setArchivePageOpen: (open: boolean) => void;
  setIntegrationsCatalogOpen: (open: boolean) => void;
  setUsageStatsPageOpen: (open: boolean) => void;
  setSourceBoardOpen: (open: boolean) => void;
  setOverviewOpen: (open: boolean) => void;
  setOpenGuestPage: (id: string | null) => void;
  setWorktreesPageProjectId: (projectId: string | null) => void;
  setSpacesPageProjectId: (projectId: string | null) => void;
  closeMainSurfaces: () => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setNewWorktreeDialogOpen: (open: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
  applyTheme: () => void;
  setSidebarSection: (section: SidebarSection) => void;
  setSettingsPage: (slug: string) => void;
  setSettingsProjectsSelectedId: (projectId: string | null) => void;
  setSettingsProjectPath: (path: string | null) => void;
  setSettingsProvidersConnectRequested: (requested: boolean) => void;
  setSettingsProvidersClassificationRequested: (requested: boolean) => void;
  setSettingsProvidersOpenRequested: (providerId: string | null) => void;
  requestSettingsJump: (page: string, itemId?: string | null) => void;
  openSettingsAt: (page: string, itemId?: string | null) => void;
  clearSettingsJumpRequest: () => void;
  setSettingsRemoteInstancesSelectedId: (instanceId: string | null) => void;
  setEventStreamStatus: (status: EventStreamStatus, hint?: string | null) => void;
  setShowReasoningTraces: (value: boolean) => void;
  setStreamingAutoFollowEnabled: (value: boolean) => void;
  setSessionRecapEnabled: (value: boolean) => void;
  setSessionSuggestionEnabled: (value: boolean) => void;
  setSessionWorkEnabled: (value: boolean) => void;
  setSessionReviewOfferEnabled: (value: boolean) => void;
  setSessionGoalEnabled: (value: boolean) => void;
  setSessionGoalChecker: (value: SessionGoalChecker) => void;
  setSessionGoalMaxAutoTurns: (value: number) => void;
  setSessionGoalDefaultBudgetEnabled: (value: boolean) => void;
  setSessionGoalDefaultBudget: (value: number) => void;
  setCollapsibleThinkingBlocks: (value: boolean) => void;
  setExpandReasoningWhileStreaming: (value: boolean) => void;
  setActivityRenderMode: (value: ActivityRenderMode) => void;
  setShowDeletionDialog: (value: boolean) => void;
  setAutoDeleteEnabled: (value: boolean) => void;
  setMergedWorktreeCleanupEnabled: (value: boolean) => void;
  setWorktreeArchiveOnDoneEnabled: (value: boolean) => void;
  setAutoSaveEnabled: (value: boolean) => void;
  setFileEditorWrapLines: (value: boolean) => void;
  setConfirmFileTreeMove: (value: boolean) => void;
  setLayoutAnimations: (value: boolean) => void;
  setOpenLinksInBrowserPanel: (value: boolean) => void;
  setLiveBrowserTabLimit: (value: number) => void;
  setAgentBrowserSharesLogins: (value: boolean) => void;
  setOpenTrackerLinksOnBoard: (value: boolean) => void;
  setFileTreeSide: (side: 'left' | 'right') => void;
  setAutoDeleteAfterDays: (days: number) => void;
  setSessionRetentionAction: (value: SessionRetentionAction) => void;
  setSessionRetentionOnlyArchived: (value: boolean) => void;
  setSessionRetentionIncludeInWork: (value: boolean) => void;
  setAutoDeleteLastRunAt: (timestamp: number | null) => void;
  setMessageLimit: (value: number) => void;
  setFontSize: (size: number) => void;
  setChatFontSize: (size: number) => void;
  setGlobalDraftStarters: (refs: DraftStarterRef[]) => void;
  setDraftStartersVisible: (value: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  setTerminalLoginShells: (shells: TerminalShell[]) => void;
  setTerminalCloseOnExit: (value: boolean) => void;
  setTerminalOpenOnProjectAction: (value: boolean) => void;
  setEditorFontSize: (size: number) => void;
  setUiFont: (font: UiFontOption) => void;
  setMonoFont: (font: MonoFontOption) => void;
  setCustomUiFont: (family: string) => void;
  setCustomMonoFont: (family: string) => void;
  setUiFontWeight: (weight: UiFontWeight) => void;
  setPadding: (size: number) => void;
  setCornerRadius: (radius: number) => void;
  setInputBarOffset: (offset: number) => void;
  setMobileKeyboardMode: (mode: MobileKeyboardMode) => void;
  applyTypography: () => void;
  applyPadding: () => void;
  toggleFavoriteModel: (providerID: string, modelID: string) => void;
  reorderFavoriteModel: (
    activeProviderID: string,
    activeModelID: string,
    overProviderID: string,
    overModelID: string,
  ) => void;
  setProviderOrder: (orderedProviderIDs: string[]) => void;
  setCustomProviderIcon: (providerID: string, icon: CustomProviderIcon | null) => void;
  setCustomProviderLogo: (providerID: string, logo: CustomProviderLogo | null) => void;
  toggleHiddenModel: (providerID: string, modelID: string) => void;
  isHiddenModel: (providerID: string, modelID: string) => boolean;
  hideAllModels: (providerID: string, modelIDs: string[]) => void;
  showAllModels: (providerID: string) => void;
  toggleModelProviderCollapsed: (providerID: string) => void;
  setModelProvidersCollapsed: (providerIDs: string[], collapsed: boolean) => void;
  isFavoriteModel: (providerID: string, modelID: string) => boolean;
  addRecentModel: (providerID: string, modelID: string) => void;
  setLastSelectedModel: (providerID: string, modelID: string) => void;
  addRecentAgent: (agentName: string) => void;
  toggleFavoriteAgent: (agentName: string) => void;
  addRecentEffort: (providerID: string, modelID: string, variant: string | undefined) => void;
  rememberLastUsedEffort: (providerID: string, modelID: string, variant: string | null) => void;
  setDiffLayoutPreference: (mode: 'dynamic' | 'inline' | 'side-by-side') => void;
  setDiffLayoutForAllFiles: (mode: 'inline' | 'side-by-side') => void;
  setDiffFileLayout: (filePath: string, mode: 'inline' | 'side-by-side') => void;
  setDiffWrapLines: (wrap: boolean) => void;
  setDiffHideWhitespace: (hide: boolean) => void;
  setDiffFileListMode: (mode: 'flat' | 'tree') => void;
  setDiffFileTreeWidth: (width: number) => void;
  setWalkthroughTocWidth: (width: number) => void;
  setGitChangesViewMode: (mode: 'flat' | 'tree') => void;
  setToolJsonViewMode: (mode: 'summary' | 'formatted' | 'raw') => void;
  setRunOverviewKey: (runKey: string | null) => void;
  setTimelineDialogOpen: (open: boolean) => void;
  setPromptNavigatorPanelOpen: (open: boolean) => void;
  togglePromptNavigatorPanel: () => void;
  setImagePreviewOpen: (open: boolean) => void;
  setNativeNotificationsEnabled: (value: boolean) => void;
  setNotificationMode: (mode: 'always' | 'hidden-only') => void;
  setShowTerminalQuickKeysOnDesktop: (value: boolean) => void;
  setSessionTabsEnabled: (value: boolean) => void;
  setSessionTabsPerWorkspace: (value: boolean) => void;
  setNotifyOnSubtasks: (value: boolean) => void;
  setDockBadgeEnabled: (value: boolean) => void;
  setAlwaysShowScrollbars: (value: boolean) => void;
  setMobileKeepScreenAwake: (value: MobileKeepScreenAwake) => void;
  setQuestionsInChat: (value: boolean) => void;
  setNotifyOnCompletion: (value: boolean) => void;
  setNotifyOnPullRequests: (value: boolean) => void;
  setNotifyOnError: (value: boolean) => void;
  setNotifyOnQuestion: (value: boolean) => void;
  setNotificationTemplates: (
    templates: UIStore['notificationTemplates'] | ((current: UIStore['notificationTemplates']) => UIStore['notificationTemplates']),
  ) => void;
  setSummarizeLastMessage: (value: boolean) => void;
  setSummaryThreshold: (value: number) => void;
  setSummaryLength: (value: number) => void;
  setMaxLastMessageLength: (value: number) => void;
  setShowOpenCodeUpdateNotifications: (value: boolean) => void;
  setAgentControlToolEnabled: (value: boolean) => void;
  setAgentScheduleToolEnabled: (value: boolean) => void;
  setAgentWebToolEnabled: (value: boolean) => void;
  setMessageSearchEnabled: (value: boolean) => void;
  setMessageSearchReasoningEnabled: (value: boolean) => void;
  setBrowserProvider: (value: string) => void;
  setAgentMemoryToolEnabled: (value: boolean) => void;
  setAgentKnowledgeToolEnabled: (value: boolean) => void;
  setAgentNotifyToolEnabled: (value: boolean) => void;
  setAgentUsageToolEnabled: (value: boolean) => void;
  setAgentTerminalToolEnabled: (value: boolean) => void;
  setAgentImageToolEnabled: (value: boolean) => void;
  setAgentImageModel: (value: string) => void;
  setAgentMemoryDreamingEnabled: (value: boolean) => void;
  setAgentMemoryDreamingModel: (value: string) => void;
  setAgentMemoryDreamingVariant: (value: string) => void;
  setAgentRenderToolEnabled: (value: boolean) => void;
  setAgentSecretToolEnabled: (value: boolean) => void;
  setAgentWorkflowToolEnabled: (value: boolean) => void;
  setIsolatedSpacesEnabled: (value: boolean) => void;
  setPermissionDefaultMode: (value: PermissionMode) => void;
  setAgentMemoryFeatureAvailable: (value: boolean) => void;
  setAgentWorkflowFeatureAvailable: (value: boolean) => void;
  setRoutingFeatureAvailable: (value: boolean) => void;
  setOverviewFeatureAvailable: (value: boolean) => void;
  markAgentMemoryViewed: (key: string, viewedAt: number) => void;
  setProjectContextTab: (value: string) => void;
  openProjectKnowledgePlan: (directory: string, projectContextId: string, planId: string) => void;
  clearProjectKnowledgePlanRequest: () => void;
  setInputSpellcheckEnabled: (value: boolean) => void;
  setLargeTextPasteBehavior: (value: LargeTextPasteBehavior) => void;
  setEnterToSend: (value: boolean) => void;
  setMobileReturnKeySends: (value: boolean) => void;
  setEnterToSendConfigured: (value: boolean) => void;
  setChatWidth: (value: ChatWidth) => void;
  setCodeBlockLineWrap: (value: boolean) => void;
  setTableCellWrap: (value: boolean) => void;
  setCopyMessagesAsPlainText: (value: boolean) => void;
  setSelectionApprovalText: (value: string) => void;
  setShowToolFileIcons: (value: boolean) => void;
  setShowTurnChangedFiles: (value: boolean) => void;
  setTimeFormatPreference: (value: TimeFormatPreference) => void;
  setWeekStartPreference: (value: WeekStartPreference) => void;
  setDesktopWindowControlsPosition: (value: DesktopWindowControlsPosition) => void;
  setDesktopWindowControlsStyle: (value: DesktopWindowControlsStyle) => void;
  setMermaidRenderingMode: (value: MermaidRenderingMode) => void;
  setUserMessageRenderingMode: (value: UserMessageRenderingMode) => void;
  setCollapsibleUserMessages: (value: boolean) => void;
  setStickyUserHeader: (value: boolean) => void;
  setPromptNavigatorEnabled: (value: boolean) => void;
  setShowSplitAssistantMessageActions: (value: boolean) => void;
  setAllowPromptingSubagentSessions: (value: boolean) => void;
  setSavePastedImagesAsFiles: (value: boolean) => void;
  viewPagerPage: 'left' | 'center' | 'right';
  setViewPagerPage: (page: 'left' | 'center' | 'right') => void;
  toggleExpandedInput: () => void;
  setExpandedInput: (value: boolean) => void;
  requestParallelComposer: (prompt?: string) => void;
  consumeParallelComposerRequest: (id: number) => void;
  setReportUsage: (value: boolean) => void;
  setShortcutOverride: (actionId: string, combo: ShortcutCombo) => void;
  clearShortcutOverride: (actionId: string) => void;
  resetAllShortcutOverrides: () => void;
  setFileEditorKeymap: (value: FileEditorKeymap) => void;
  setFileEditorVimMappings: (value: string) => void;
}


const openFileTab = (state: UIStore, directory: string, filePath: string, preview: boolean) => {
  const tabs = state.contextPanelByDirectory[directory]?.tabs ?? [];
  const replacedPreviewPath = preview
    ? tabs.find((tab) => tab.preview && tab.targetPath !== filePath)?.targetPath ?? null
    : null;
  const alreadyOpen = tabs.some((tab) => tab.mode === 'file' && tab.targetPath === filePath);
  state.openContextPanelTab(directory, { mode: 'file', targetPath: filePath, preview });
  if (replacedPreviewPath && !alreadyOpen) {
    useFilesViewTabsStore.getState().removeOpenPath(directory, replacedPreviewPath);
  }
};

export const DEFAULT_SELECTION_APPROVAL_TEXT = 'Sounds good';
export const DEFAULT_EDITOR_FONT_SIZE = 12;
export const DEFAULT_CONTEXT_EDITOR_TREE_WIDTH = 208;

export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set, get) => ({

        theme: 'system',
        runOverviewKey: null,
        parallelComposerRequest: null,
        isSidebarOpen: true,
        sidebarFoldedForExpandedZone: false,
        sidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
        contextPanelByDirectory: {},
        contextRailOrder: [],
        contextRailHiddenSurfaces: [],
        mobileWorkspaceTabOrder: [],
        mobileWorkspaceHiddenTabs: [],
        mobileWorkStatusHiddenSections: ['subagents'],
        contextSurfaceZones: {},
        contextEditorTreeVisible: true,
        fileTreeSide: 'right',
        contextEditorVisible: true,
        contextEditorTreeWidth: DEFAULT_CONTEXT_EDITOR_TREE_WIDTH,
        contextZoneSizes: {},
        contextZoneExpandedChatSizes: {},
        workStatusExpandedSections: {},
        messageQueueExpanded: false,
        workStatusScrollTop: 0,
        workStatusPanelEnabled: true,
        workStatusPanelVisible: false,
        workStatusPanelFits: false,
        workStatusOverlayOpen: false,
        workStatusHiddenSections: [],
        workStatusSectionOrder: sanitizeWorkStatusSectionOrder([]),
        workStatusSectionOrderExplicit: false,
        workStatusHiddenSectionsExplicit: false,
        isSessionSwitcherOpen: false,
        isSessionDropdownOpen: false,
        pendingDiffFile: null,
        pendingDiffStaged: false,
        pendingDiffScope: null,
        pendingTurnDiffFile: null,
        pendingFileNavigation: null,
        pendingFileFocusPath: null,
        isMobile: false,
        isCommandPaletteOpen: false,
        isHelpDialogOpen: false,
        isProjectActionsDialogOpen: false,
        isAboutDialogOpen: false,
        isOpenCodeStatusDialogOpen: false,
        openCodeStatusText: '',
        isSessionCreateDialogOpen: false,
        isScheduledTasksDialogOpen: false,
        isArchivePageOpen: false,
        isIntegrationsCatalogOpen: false,
        archivePageOpenCount: 0,
        isUsageStatsPageOpen: false,
        isSourceBoardOpen: false,
        isOverviewOpen: false,
        openGuestPageId: null,
        worktreesPageProjectId: null,
        spacesPageProjectId: null,
        isSettingsDialogOpen: false,
        isNewWorktreeDialogOpen: false,
        isModelSelectorOpen: false,
        sidebarSection: 'sessions',
        settingsPage: 'home',
        settingsHasOpenedOnce: false,
        settingsProjectsSelectedId: null,
        settingsProjectPath: null,
        settingsProvidersConnectRequested: false,
        settingsProvidersClassificationRequested: false,
        settingsProvidersOpenRequested: null,
        settingsJumpRequest: null,
        settingsRemoteInstancesSelectedId: null,
        eventStreamStatus: 'idle',
        eventStreamHint: null,
        showReasoningTraces: true,
        streamingAutoFollowEnabled: true,
        sessionRecapEnabled: true,
        sessionSuggestionEnabled: true,
        sessionWorkEnabled: true,
        sessionReviewOfferEnabled: false,
        sessionGoalEnabled: true,
        sessionGoalChecker: 'small-model',
        sessionGoalMaxAutoTurns: DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS,
        sessionGoalDefaultBudgetEnabled: false,
        sessionGoalDefaultBudget: 200_000,
        collapsibleThinkingBlocks: true,
        expandReasoningWhileStreaming: false,
        activityRenderMode: 'summary',
        showDeletionDialog: true,
        autoDeleteEnabled: false,
        autoSaveEnabled: true,
        fileEditorWrapLines: true,
        confirmFileTreeMove: true,
        layoutAnimations: true,
        openLinksInBrowserPanel: false,
        liveBrowserTabLimit: LIVE_BROWSER_TABS_DEFAULT,
        agentBrowserSharesLogins: false,
        openTrackerLinksOnBoard: true,
        autoDeleteAfterDays: 30,
        sessionRetentionAction: 'archive',
        sessionRetentionOnlyArchived: false,
        sessionRetentionIncludeInWork: false,
        mergedWorktreeCleanupEnabled: false,
        worktreeArchiveOnDoneEnabled: false,
        autoDeleteLastRunAt: null,
        messageLimit: 200,
        fontSize: 100,
        chatFontSize: 100,
        globalDraftStarters: null,
        terminalFontSize: 14,
        terminalShell: 'auto',
        terminalLoginShells: [],
        terminalCloseOnExit: true,
        terminalOpenOnProjectAction: true,
        editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
        uiFont: DEFAULT_UI_FONT,
        monoFont: DEFAULT_MONO_FONT,
        customUiFont: '',
        customMonoFont: '',
        uiFontWeight: DEFAULT_UI_FONT_WEIGHT,
        padding: 100,
        cornerRadius: 18,
        inputBarOffset: 0,
        mobileKeyboardMode: getStoredMobileKeyboardMode(),
        favoriteModels: [],
        hiddenModels: [],
        providerOrder: [],
        collapsedModelProviders: [],
        customProviderIcons: {},
        customProviderLogos: {},
        recentModels: [],
        lastSelectedModel: undefined,
        recentAgents: [],
        favoriteAgents: [],
        recentEfforts: {},
        lastUsedEfforts: {},
        diffLayoutPreference: 'inline',
        diffFileLayout: {},
        diffWrapLines: false,
        diffHideWhitespace: false,
        diffFileListMode: 'flat',
        diffFileTreeWidth: 240,
        walkthroughTocWidth: 224,
        gitChangesViewMode: 'flat',
        toolJsonViewMode: 'summary',
        isTimelineDialogOpen: false,
        isPromptNavigatorPanelOpen: false,
        isImagePreviewOpen: false,
        nativeNotificationsEnabled: false,
        notificationMode: 'hidden-only',
        notifyOnSubtasks: true,
        dockBadgeEnabled: true,
        alwaysShowScrollbars: false,
        mobileKeepScreenAwake: 'off',
        questionsInChat: false,

        notifyOnCompletion: true,
        notifyOnPullRequests: true,
        notifyOnError: true,
        notifyOnQuestion: true,
        notificationTemplates: {
          completion: { ...EMPTY_NOTIFICATION_TEMPLATES.completion },
          error: { ...EMPTY_NOTIFICATION_TEMPLATES.error },
          question: { ...EMPTY_NOTIFICATION_TEMPLATES.question },
          subtask: { ...EMPTY_NOTIFICATION_TEMPLATES.subtask },
        },

        summarizeLastMessage: false,
        summaryThreshold: 200,
        summaryLength: 100,
        maxLastMessageLength: 250,

        showTerminalQuickKeysOnDesktop: false,
        sessionTabsEnabled: false,
        sessionTabsPerWorkspace: false,
        showOpenCodeUpdateNotifications: true,
        agentControlToolEnabled: true,
        agentScheduleToolEnabled: true,
        agentWebToolEnabled: true,
        messageSearchEnabled: false,
        messageSearchReasoningEnabled: false,
        browserProvider: 'builtin',
        agentMemoryToolEnabled: false,
        agentKnowledgeToolEnabled: true,
        agentNotifyToolEnabled: false,
        agentUsageToolEnabled: false,
        agentTerminalToolEnabled: false,
        agentImageToolEnabled: false,
        agentImageModel: '',
        agentMemoryDreamingEnabled: false,
        agentMemoryDreamingModel: '',
        agentMemoryDreamingVariant: '',
        agentRenderToolEnabled: true,
        agentSecretToolEnabled: true,
        agentWorkflowToolEnabled: false,
        agentWorkflowAutoApprove: false,
        isolatedSpacesEnabled: false,
        permissionDefaultMode: 'ask',
        agentMemoryFeatureAvailable: false,
        agentWorkflowFeatureAvailable: false,
        routingFeatureAvailable: false,
        overviewFeatureAvailable: false,
        agentMemoryViewedAt: {},
        projectContextTab: 'notes',
        projectKnowledgePlanRequest: null,
        inputSpellcheckEnabled: false,
        largeTextPasteBehavior: DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR,
        enterToSend: false,
        enterToSendConfigured: false,
        mobileReturnKeySends: false,
        chatWidth: 'default',
        codeBlockLineWrap: true,
        tableCellWrap: true,
        copyMessagesAsPlainText: true,
        selectionApprovalText: '',
        showToolFileIcons: true,
        showTurnChangedFiles: false,
        timeFormatPreference: 'auto',
        weekStartPreference: 'auto',
        desktopWindowControlsPosition: 'right',
        desktopWindowControlsStyle: 'classic',
        mermaidRenderingMode: 'svg',
        userMessageRenderingMode: 'markdown',
        collapsibleUserMessages: true,
        stickyUserHeader: false,
        promptNavigatorEnabled: true,
        showSplitAssistantMessageActions: false,
        allowPromptingSubagentSessions: false,
        savePastedImagesAsFiles: false,
        draftStartersVisible: true,
        isExpandedInput: false,
        reportUsage: true,
        shortcutOverrides: {},
        fileEditorKeymap: 'default',
        fileEditorVimMappings: '',

        setTheme: (theme) => {
          set({ theme });
          get().applyTheme();
        },

        toggleSidebar: () => {
          set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
        },

        setSidebarOpen: (open) => {
          set((state) => state.isSidebarOpen === open ? state : { isSidebarOpen: open });
        },

        setSidebarFoldedForExpandedZone: (folded) => {
          set((state) => state.sidebarFoldedForExpandedZone === folded ? state : { sidebarFoldedForExpandedZone: folded });
        },

        setSidebarWidth: (width) => {
          set({ sidebarWidth: width });
        },

        setContextRailOrder: (order) => {
          const sanitized = Array.isArray(order)
            ? order.filter((id, index) => typeof id === 'string' && id.trim() !== '' && order.indexOf(id) === index)
            : [];
          set({ contextRailOrder: sanitized });
        },

        toggleContextEditorTree: () => {
          set((state) => (state.contextEditorTreeVisible && !state.contextEditorVisible
            ? { contextEditorTreeVisible: false, contextEditorVisible: true }
            : { contextEditorTreeVisible: !state.contextEditorTreeVisible }));
        },

        toggleContextEditor: () => {
          set((state) => (state.contextEditorVisible && !state.contextEditorTreeVisible
            ? { contextEditorVisible: false, contextEditorTreeVisible: true }
            : { contextEditorVisible: !state.contextEditorVisible }));
        },

        setContextEditorTreeWidth: (width) => {
          if (!Number.isFinite(width)) {
            return;
          }
          set({ contextEditorTreeWidth: clampContextEditorTreeWidth(width) });
        },

        openContextSurface: (directory, mode) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          const state = get();
          const placement = state.contextSurfaceZones;
          const panelState = state.contextPanelByDirectory[normalizedDirectory];
          const tabs = panelState?.tabs ?? [];
          const zone = zoneOfMode(placement, mode);
          const zoneView = panelState ? getZoneView(panelState, zone) : null;
          const activeTabId = resolveZoneActiveTabId(tabs, placement, zone, zoneView?.activeTabId ?? null);
          const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
          const clearTerminalTarget = () => {
            if (mode === 'terminal') {
              const terminalTab = tabs.find((tab) => tab.mode === 'terminal') ?? null;
              const targetDirectory = terminalTab?.targetDirectory ?? null;
              if (targetDirectory) {
                const targetState = useTerminalStore.getState().getDirectoryState(targetDirectory);
                if (directoryMayHaveActiveProjectAction(targetState)) {
                  return;
                }
              }
              state.openContextPanelTab(normalizedDirectory, { mode: 'terminal', targetDirectory: null }, { reveal: false });
            }
          };

          if (zoneView?.isOpen && activeTab?.mode === mode) {
            clearTerminalTarget();
            state.closeContextZone(normalizedDirectory, zone);
            return;
          }

          if (mode === 'file' && !state.contextEditorTreeVisible
            && !tabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
            set({ contextEditorTreeVisible: true });
          }

          const tabsOfMode = tabs.filter((tab) => tab.mode === mode);
          if (tabsOfMode.length > 0) {
            clearTerminalTarget();
            const mostRecent = tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
            if ((mode === 'diff' || mode === 'walkthrough') && mostRecent.targetDirectory) {
              state.openContextPanelTab(normalizedDirectory, {
                mode,
                targetPath: mostRecent.targetPath,
                stagedDiff: mostRecent.stagedDiff,
                diffScope: mostRecent.diffScope,
                targetDirectory: null,
              });
              return;
            }
            state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
            return;
          }

          if (mode === 'chat') {
            return;
          }

          state.openContextPanelTab(normalizedDirectory, { mode });
        },

        openContextPanelTab: (directory, tab, options) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          const nextTab = tab.mode !== 'chat' && contextPanelModeKeepsTargetDirectory(tab.mode)
            ? {
                ...tab,
                targetDirectory: normalizeContextTargetDirectory(tab.targetDirectory) === normalizedDirectory
                  ? null
                  : normalizeContextTargetDirectory(tab.targetDirectory),
              }
            : tab;

          const showsFile = nextTab.mode === 'file' && Boolean(nextTab.targetPath) && options?.reveal !== false;

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev, state.contextSurfaceZones);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: upsertContextPanelTab(current, nextTab, state.contextSurfaceZones, options),
            };

            return {
              contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
              contextEditorVisible: showsFile || state.contextEditorVisible,
            };
          });
        },

        openTrackerItem: (directory, item) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const url = item.url.trim();
          if (!normalizedDirectory || !url) {
            return null;
          }

          const dedupeKey = `tracker:${item.key}`;
          const targetDirectory = normalizeContextTargetDirectory(item.targetDirectory);
          set((state) => {
            const placement = state.contextSurfaceZones;
            const current = touchContextPanelState(state.contextPanelByDirectory[normalizedDirectory], placement);
            const withBranch = current.tabs.some(isTrackerBranchTab)
              ? current
              : upsertContextPanelTab(current, { mode: 'pr' }, placement, { reveal: false });
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: upsertContextPanelTab(withBranch, {
                mode: 'pr',
                targetPath: url,
                dedupeKey,
                label: item.label,
                targetDirectory: targetDirectory === normalizedDirectory ? null : targetDirectory,
              }, placement),
            };
            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
          return buildContextPanelTabID('pr', dedupeKey);
        },

        openContextDiff: (directory, filePath, staged = false, scope = null) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = (filePath || '').trim();
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          const diffScope = normalizePendingDiffScope(scope) ?? (staged ? 'staged' : 'working');

          get().openContextPanelTab(normalizedDirectory, {
            mode: 'diff',
            targetPath: normalizedFilePath,
            stagedDiff: diffScope === 'staged',
            diffScope,
          });
        },

        openContextFile: (directory, filePath, options) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
          get().setPendingFileFocusPath(normalizedFilePath);
          get().setPendingFileNavigation(null);
          if (options?.expanded) {
            const zone = zoneOfMode(get().contextSurfaceZones, 'file');
            const panel = get().contextPanelByDirectory[normalizedDirectory];
            if (panel && !getZoneView(panel, zone).expanded) {
              get().toggleContextPanelExpanded(normalizedDirectory, zone);
            }
          }
        },

        openContextFileAtLine: (directory, filePath, line, column, options) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
          const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
          get().setPendingFileFocusPath(null);
          get().setPendingFileNavigation({
            path: normalizedFilePath,
            line: normalizedLine,
            column: normalizedColumn,
          });
        },

        openContextOverview: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'context' });
        },

        openContextPreview: (directory, url) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedUrl = (url || '').trim();
          if (!normalizedDirectory || !normalizedUrl || isVSCodeRuntime()) {
            return;
          }

          noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, normalizedUrl, normalizedUrl);
          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: normalizedUrl,
            dedupeKey: normalizedUrl,
            label: null,
          });
        },
        openAgentBrowserTab: (directory, url, ownerSessionId) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory || isVSCodeRuntime()) return null;
          browserTabSequence += 1;
          const dedupeKey = `browser:agent:${Date.now()}-${browserTabSequence}`;
          if (url.trim()) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, dedupeKey, url.trim());
          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: url.trim(),
            dedupeKey,
            label: null,
            ownerSessionId,
          }, { reveal: false });
          return buildContextPanelTabID('browser', dedupeKey);
        },
        openNewContextBrowserTab: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory || isVSCodeRuntime()) return;
          browserTabSequence += 1;
          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: '',
            dedupeKey: `browser:new:${Date.now()}-${browserTabSequence}`,
            label: null,
          });
        },
        openContextBrowser: (directory, url = '', options) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory || isVSCodeRuntime()) return;
          const targetUrl = typeof url === 'string' && url.trim().length > 0 ? url.trim() : '';
          if (targetUrl) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, targetUrl, targetUrl);
          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: targetUrl,
            dedupeKey: targetUrl || 'browser',
            label: null,
          }, options);
        },

        setContextPanelTabTargetPath: (directory, tabID, targetPath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          if (!normalizedDirectory || !normalizedTabID) return;
          set((state) => {
            const current = state.contextPanelByDirectory[normalizedDirectory];
            if (!current) return state;
            return {
              contextPanelByDirectory: {
                ...state.contextPanelByDirectory,
                [normalizedDirectory]: setContextPanelTabTargetPath(current, normalizedTabID, targetPath),
              },
            };
          });
        },

        moveContextFilePaths: (directory, fromPath, toPath, filesRoot = directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFrom = normalizeContextTargetPath(fromPath);
          const normalizedTo = normalizeContextTargetPath(toPath);
          if (!normalizedDirectory || !normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return;
          set((state) => {
            const current = state.contextPanelByDirectory[normalizedDirectory];
            if (!current) return state;
            const next = moveContextPanelFileTabs(current, normalizedFrom, normalizedTo);
            if (next === current) return state;
            return {
              contextPanelByDirectory: {
                ...state.contextPanelByDirectory,
                [normalizedDirectory]: next,
              },
            };
          });
          useFilesViewTabsStore.getState().movePaths(normalizeDirectoryPath(filesRoot.trim()), normalizedFrom, normalizedTo);
        },

        setActiveContextPanelTab: (directory, tabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          if (!normalizedDirectory || !normalizedTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev, state.contextSurfaceZones);
            const targetTab = current.tabs.find((tab) => tab.id === normalizedTabID);
            if (!targetTab) {
              return state;
            }

            const showsFile = targetTab.mode === 'file' && Boolean(targetTab.targetPath);
            const zone = zoneOfMode(state.contextSurfaceZones, targetTab.mode);
            const view = getZoneView(current, zone);

            if (view.activeTabId === normalizedTabID && view.isOpen) {
              return showsFile ? { contextEditorVisible: true } : state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: withZoneView({
                ...current,
                touchedAt: Date.now(),
                tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
                  ? { ...tab, touchedAt: Date.now() }
                  : tab)),
              }, zone, { isOpen: true, activeTabId: normalizedTabID }),
            };

            return {
              contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
              contextEditorVisible: showsFile || state.contextEditorVisible,
            };
          });
        },

        reorderContextPanelTabs: (directory, activeTabID, overTabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedActiveTabID = (activeTabID || '').trim();
          const normalizedOverTabID = (overTabID || '').trim();
          if (!normalizedDirectory || !normalizedActiveTabID || !normalizedOverTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev, state.contextSurfaceZones);
            if (!current.tabs.some((tab) => tab.id === normalizedActiveTabID) || !current.tabs.some((tab) => tab.id === normalizedOverTabID)) {
              return state;
            }

            const next = reorderContextPanelTabs(current, normalizedActiveTabID, normalizedOverTabID);
            if (next.tabs === current.tabs) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: next,
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        pinContextPanelTab: (directory, tabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) return;
          set((state) => {
            const current = state.contextPanelByDirectory[normalizedDirectory];
            if (!current?.tabs.some((tab) => tab.id === tabID && tab.preview)) return state;
            return {
              contextPanelByDirectory: {
                ...state.contextPanelByDirectory,
                [normalizedDirectory]: {
                  ...current,
                  tabs: current.tabs.map((tab) => (tab.id === tabID ? { ...tab, preview: false } : tab)),
                },
              },
            };
          });
        },

        closeContextPanelTab: (directory, tabID) => {
          get().closeContextPanelTabs(directory, [tabID]);
        },

        closeContextFile: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }
          const tab = get().contextPanelByDirectory[normalizedDirectory]?.tabs
            .find((candidate) => candidate.mode === 'file' && candidate.targetPath === normalizedFilePath);
          if (tab) {
            get().closeContextPanelTabs(normalizedDirectory, [tab.id]);
            return;
          }
          useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, normalizedFilePath);
        },

        closeContextPanelTabs: (directory, tabIds) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const branchTabIds = new Set((get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? [])
            .filter(isTrackerBranchTab)
            .map((tab) => tab.id));
          const normalizedTabIds = (tabIds ?? [])
            .map((id) => (id || '').trim())
            .filter((id) => id.length > 0 && !branchTabIds.has(id));
          if (!normalizedDirectory || normalizedTabIds.length === 0) {
            return;
          }

          const closedTabs = normalizedTabIds
            .map((id) => get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === id))
            .filter((tab): tab is ContextPanelTab => Boolean(tab));

          set((state) => {
            const placement = state.contextSurfaceZones;
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev, placement);
            if (!current.tabs.some((tab) => normalizedTabIds.includes(tab.id))) {
              return state;
            }

            const next = closeContextPanelTabs(current, normalizedTabIds, placement);
            const fileView = getZoneView(next, zoneOfMode(placement, 'file'));
            const activeTab = next.tabs.find((tab) => tab.id === fileView.activeTabId);
            const returnedToTree = fileView.isOpen && activeTab?.mode === 'file' && !activeTab.targetPath;
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: next,
            };

            return {
              contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20),
              contextEditorTreeVisible: returnedToTree || state.contextEditorTreeVisible,
            };
          });

          for (const tab of closedTabs) {
            if (tab.mode === 'file' && tab.targetPath) {
              useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, tab.targetPath);
            }
          }
        },

        closeContextPanel: (directory) => {
          get().closeContextZone(directory, 'right');
        },

        closeContextZone: (directory, zone) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            if (!prev || !getZoneView(prev, zone).isOpen) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: withZoneView(touchContextPanelState(prev, state.contextSurfaceZones), zone, { isOpen: false }),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        toggleContextPanelExpanded: (directory, zone = 'right') => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev, state.contextSurfaceZones);
            const expanded = !getZoneView(current, zone).expanded;
            let next = current;
            for (const other of CONTEXT_ZONES) {
              next = withZoneView(next, other, { expanded: other === zone ? expanded : false });
            }
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: next,
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        setContextZoneSize: (zone, size) => {
          set((state) => ({ contextZoneSizes: { ...state.contextZoneSizes, [zone]: clampContextZoneSize(zone, size) } }));
        },

        setContextZoneExpandedChatSize: (zone, size) => {
          if (!Number.isFinite(size)) return;
          set((state) => ({ contextZoneExpandedChatSizes: { ...state.contextZoneExpandedChatSizes, [zone]: Math.max(0, Math.round(size)) } }));
        },

        moveContextSurfaceToZone: (mode, zone) => {
          set((state) => {
            const from = zoneOfMode(state.contextSurfaceZones, mode);
            if (from === zone) {
              return state;
            }

            const placement: ContextZonePlacement = { ...state.contextSurfaceZones };
            if (zone === 'right') {
              delete placement[mode];
            } else {
              placement[mode] = zone;
            }

            const byDirectory: Record<string, ContextPanelDirectoryState> = {};
            for (const [directory, panel] of Object.entries(state.contextPanelByDirectory)) {
              byDirectory[directory] = carrySurfaceToZone(panel, mode, from, zone, placement);
            }

            return { contextSurfaceZones: placement, contextPanelByDirectory: byDirectory };
          });
        },

        setWorkStatusSectionExpanded: (sectionId, expanded) => {
          set((state) => (
            state.workStatusExpandedSections[sectionId] === expanded
              ? state
              : {
                workStatusExpandedSections: {
                  ...state.workStatusExpandedSections,
                  [sectionId]: expanded,
                },
              }
          ));
        },

        setMessageQueueExpanded: (expanded) => {
          set((state) => (state.messageQueueExpanded === expanded ? state : { messageQueueExpanded: expanded }));
        },

        setWorkStatusScrollTop: (scrollTop) => {
          set({ workStatusScrollTop: Math.max(0, scrollTop) });
        },

        setWorkStatusPanelEnabled: (enabled) => {
          set({ workStatusPanelEnabled: enabled });
        },

        setWorkStatusPanelVisible: (visible) => {
          set((state) => (state.workStatusPanelVisible === visible ? state : { workStatusPanelVisible: visible }));
        },

        setWorkStatusPanelFits: (fits) => {
          set((state) => {
            if (state.workStatusPanelFits === fits) return state;
            return fits
              ? { workStatusPanelFits: true, workStatusOverlayOpen: false }
              : { workStatusPanelFits: false };
          });
        },

        setWorkStatusOverlayOpen: (open) => {
          set((state) => (state.workStatusOverlayOpen === open ? state : { workStatusOverlayOpen: open }));
        },

        setWorkStatusSectionVisible: (sectionId, visible) => {
          set((state) => {
            const hidden = state.workStatusHiddenSections;
            const isHidden = hidden.includes(sectionId);
            if (visible === !isHidden) return state;
            return {
              workStatusHiddenSectionsExplicit: true,
              workStatusHiddenSections: visible
                ? hidden.filter((entry) => entry !== sectionId)
                : [...hidden, sectionId],
            };
          });
        },

        setWorkStatusHiddenSections: (sectionIds) => {
          set({ workStatusHiddenSections: [...new Set(sectionIds)], workStatusHiddenSectionsExplicit: true });
        },
        setMobileWorkStatusSectionVisible: (sectionId, visible) => {
          set((state) => {
            const hidden = state.mobileWorkStatusHiddenSections;
            if (visible === !hidden.includes(sectionId)) return state;
            return {
              mobileWorkStatusHiddenSections: visible
                ? hidden.filter((entry) => entry !== sectionId)
                : [...hidden, sectionId],
            };
          });
        },
        setMobileWorkStatusHiddenSections: (sectionIds) => {
          set({ mobileWorkStatusHiddenSections: [...new Set(sectionIds)] });
        },
        setWorkStatusSectionOrder: (sectionIds) => {
          set({ workStatusSectionOrder: sanitizeWorkStatusSectionOrder(sectionIds), workStatusSectionOrderExplicit: true });
        },

        setContextRailSurfaceVisible: (surfaceId, visible) => {
          set((state) => {
            const hidden = state.contextRailHiddenSurfaces;
            const isHidden = hidden.includes(surfaceId);
            if (visible === !isHidden) return state;
            return {
              contextRailHiddenSurfaces: visible
                ? hidden.filter((entry) => entry !== surfaceId)
                : [...hidden, surfaceId],
            };
          });
        },

        setContextRailHiddenSurfaces: (surfaceIds) => {
          set({ contextRailHiddenSurfaces: [...new Set(surfaceIds)] });
        },

        setMobileWorkspaceTabOrder: (order) => {
          set((state) => ({ mobileWorkspaceTabOrder: storedMobileWorkspaceTabOrder(order, state.mobileWorkspaceTabOrder) }));
        },

        setMobileWorkspaceTabVisible: (tab, visible, extensions) => {
          set((state) => {
            const hidden = state.mobileWorkspaceHiddenTabs;
            if (visible) {
              return hidden.includes(tab) ? { mobileWorkspaceHiddenTabs: hidden.filter((entry) => entry !== tab) } : state;
            }
            if (hidden.includes(tab)) return state;
            const shown = shownMobileWorkspaceTabs(state.mobileWorkspaceTabOrder, hidden, extensions);
            if (shown.length <= 1) return state;
            return { mobileWorkspaceHiddenTabs: [...hidden, tab] };
          });
        },


        setSessionSwitcherOpen: (open) => {
          if (get().isSessionSwitcherOpen === open) {
            return;
          }
          set({ isSessionSwitcherOpen: open });
        },

        setSessionDropdownOpen: (open) => {
          if (get().isSessionDropdownOpen === open) {
            return;
          }
          set({ isSessionDropdownOpen: open });
        },

        setPendingDiffFile: (filePath, staged = false, scope = null) => {
          set({
            pendingDiffFile: filePath,
            pendingDiffStaged: filePath ? staged : false,
            pendingDiffScope: filePath ? scope : null,
          });
        },

        setPendingTurnDiffFile: (request) => {
          set({ pendingTurnDiffFile: request });
        },

        setPendingFileNavigation: (navigation) => {
          set({ pendingFileNavigation: navigation });
        },

        setPendingFileFocusPath: (path) => {
          set({ pendingFileFocusPath: path });
        },

        navigateToDiff: (filePath, staged = false, scope = null) => {
          set({ pendingDiffFile: filePath, pendingDiffStaged: staged, pendingDiffScope: scope });
        },

        consumePendingDiffFile: () => {
          const { pendingDiffFile } = get();
          if (pendingDiffFile) {
            set({ pendingDiffFile: null, pendingDiffStaged: false, pendingDiffScope: null });
          }
          return pendingDiffFile;
        },

        setIsMobile: (isMobile) => {
          set({ isMobile });
        },

        toggleCommandPalette: () => {
          set((state) => ({ isCommandPaletteOpen: !state.isCommandPaletteOpen }));
        },

        setCommandPaletteOpen: (open) => {
          set({ isCommandPaletteOpen: open });
        },

        toggleHelpDialog: () => {
          set((state) => ({ isHelpDialogOpen: !state.isHelpDialogOpen }));
        },

        setHelpDialogOpen: (open) => {
          set({ isHelpDialogOpen: open });
        },

        setProjectActionsDialogOpen: (open) => {
          set({ isProjectActionsDialogOpen: open });
        },

        setAboutDialogOpen: (open) => {
          set({ isAboutDialogOpen: open });
        },

        setOpenCodeStatusDialogOpen: (open) => {
          set({ isOpenCodeStatusDialogOpen: open });
        },

        setOpenCodeStatusText: (text) => {
          set({ openCodeStatusText: text });
        },

        setSessionCreateDialogOpen: (open) => {
          set({ isSessionCreateDialogOpen: open });
        },

        setScheduledTasksDialogOpen: (open) => {
          set(open
            ? { isScheduledTasksDialogOpen: true, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isScheduledTasksDialogOpen: false });
        },

        setArchivePageOpen: (open) => {
          set(open
            ? { isArchivePageOpen: true, archivePageOpenCount: get().archivePageOpenCount + 1, isUsageStatsPageOpen: false, isIntegrationsCatalogOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isArchivePageOpen: false });
        },

        setIntegrationsCatalogOpen: (open) => {
          set(open
            ? { isIntegrationsCatalogOpen: true, isArchivePageOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isIntegrationsCatalogOpen: false });
        },

        setUsageStatsPageOpen: (open) => {
          set(open
            ? { isUsageStatsPageOpen: true, isSourceBoardOpen: false, isOverviewOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isUsageStatsPageOpen: false });
        },

        setSourceBoardOpen: (open) => {
          set(open
            ? { isSourceBoardOpen: true, isOverviewOpen: false, isUsageStatsPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isSourceBoardOpen: false });
        },

        setOverviewOpen: (open) => {
          if (open && !get().overviewFeatureAvailable) return;
          set(open
            ? { isOverviewOpen: true, isSourceBoardOpen: false, isUsageStatsPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
            : { isOverviewOpen: false });
        },

        setWorktreesPageProjectId: (projectId) => {
          set(projectId
            ? { worktreesPageProjectId: projectId, spacesPageProjectId: null, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, runOverviewKey: null, openGuestPageId: null }
            : { worktreesPageProjectId: null });
        },

        setSpacesPageProjectId: (projectId) => {
          set(projectId
            ? { spacesPageProjectId: projectId, worktreesPageProjectId: null, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, runOverviewKey: null, openGuestPageId: null }
            : { spacesPageProjectId: null });
        },

        setOpenGuestPage: (id) => {
          set(id ? { openGuestPageId: id, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null }
            : { openGuestPageId: null });
        },

        closeMainSurfaces: () => {
          const state = get();
          if (!state.isScheduledTasksDialogOpen && !state.isArchivePageOpen && !state.isIntegrationsCatalogOpen && !state.isUsageStatsPageOpen && !state.isSourceBoardOpen && !state.isOverviewOpen && !state.worktreesPageProjectId && !state.spacesPageProjectId && !state.runOverviewKey && !state.openGuestPageId) {
            return;
          }
          set({
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            isIntegrationsCatalogOpen: false,
            isUsageStatsPageOpen: false,
            isSourceBoardOpen: false,
            isOverviewOpen: false,
            worktreesPageProjectId: null,
            spacesPageProjectId: null,
            runOverviewKey: null,
            openGuestPageId: null,
          });
        },

        setSettingsDialogOpen: (open) => {
          set((state) => {
            if (!open) {
              return { isSettingsDialogOpen: false };
            }
            if (state.settingsHasOpenedOnce) {
              return { isSettingsDialogOpen: true };
            }
            return { isSettingsDialogOpen: true, settingsHasOpenedOnce: true };
          });
        },

        setNewWorktreeDialogOpen: (open) => {
          set({ isNewWorktreeDialogOpen: open });
        },

        setModelSelectorOpen: (open) => {
          set({ isModelSelectorOpen: open });
        },

        setSidebarSection: (section) => {
          set({ sidebarSection: section });
        },

        setSettingsPage: (slug) => {
          set({ settingsPage: slug });
        },

        setSettingsProvidersClassificationRequested: (requested) => {
          set({ settingsProvidersClassificationRequested: requested });
        },
        setSettingsProvidersOpenRequested: (providerId) => {
          set({ settingsProvidersOpenRequested: providerId });
        },
        requestSettingsJump: (page, itemId = null) => {
          set({ settingsJumpRequest: { page, itemId } });
        },
        openSettingsAt: (page, itemId = null) => {
          get().requestSettingsJump(page, itemId);
          get().setSettingsDialogOpen(true);
        },
        clearSettingsJumpRequest: () => {
          set({ settingsJumpRequest: null });
        },
        setSettingsProvidersConnectRequested: (requested) => {
          set({ settingsProvidersConnectRequested: requested });
        },

        setSettingsProjectPath: (path) => {
          const trimmed = path?.trim();
          set({ settingsProjectPath: trimmed ? trimmed : null });
        },

        setSettingsProjectsSelectedId: (projectId) => {
          set({ settingsProjectsSelectedId: projectId });
        },

        setSettingsRemoteInstancesSelectedId: (instanceId) => {
          set({ settingsRemoteInstancesSelectedId: instanceId });
        },

        setEventStreamStatus: (status, hint) => {
          set({
            eventStreamStatus: status,
            eventStreamHint: hint ?? null,
          });
        },

        setShowReasoningTraces: (value) => {
          set({ showReasoningTraces: value });
        },

        setStreamingAutoFollowEnabled: (value) => {
          set({ streamingAutoFollowEnabled: value });
        },

        setSessionRecapEnabled: (value) => {
          set({ sessionRecapEnabled: value });
        },

        setSessionSuggestionEnabled: (value) => {
          set({ sessionSuggestionEnabled: value });
        },

        setSessionWorkEnabled: (value) => {
          set({ sessionWorkEnabled: value });
        },

        setSessionReviewOfferEnabled: (value) => {
          set({ sessionReviewOfferEnabled: value });
        },

        setSessionGoalEnabled: (value) => {
          set({ sessionGoalEnabled: value });
        },

        setSessionGoalChecker: (value) => {
          set({ sessionGoalChecker: value });
        },

        setSessionGoalMaxAutoTurns: (value) => {
          if (!isSessionGoalMaxAutoTurns(value)) return;
          set({ sessionGoalMaxAutoTurns: value });
        },

        setSessionGoalDefaultBudgetEnabled: (value) => {
          set({ sessionGoalDefaultBudgetEnabled: value });
        },

        setSessionGoalDefaultBudget: (value) => {
          set({ sessionGoalDefaultBudget: value });
        },

        setCollapsibleThinkingBlocks: (value) => {
          set({ collapsibleThinkingBlocks: value });
        },

        setExpandReasoningWhileStreaming: (value) => {
          set({ expandReasoningWhileStreaming: value });
        },

        setActivityRenderMode: (value) => {
          set({ activityRenderMode: value });
        },

        setShowDeletionDialog: (value) => {
          set({ showDeletionDialog: value });
        },

        setAutoDeleteEnabled: (value) => {
          set({ autoDeleteEnabled: value });
        },

        setMergedWorktreeCleanupEnabled: (value) => {
          set({ mergedWorktreeCleanupEnabled: value });
        },

        setWorktreeArchiveOnDoneEnabled: (value) => {
          set({ worktreeArchiveOnDoneEnabled: value });
        },

        setAutoSaveEnabled: (value) => {
          set({ autoSaveEnabled: value });
        },

        setFileEditorWrapLines: (value) => {
          set({ fileEditorWrapLines: value });
        },

        setConfirmFileTreeMove: (value) => {
          set({ confirmFileTreeMove: value });
        },

        setLayoutAnimations: (value) => {
          set({ layoutAnimations: value });
        },

        setOpenLinksInBrowserPanel: (value) => {
          set({ openLinksInBrowserPanel: value });
        },

        setLiveBrowserTabLimit: (value) => {
          set({ liveBrowserTabLimit: clampLiveBrowserTabs(value) });
        },

        setAgentBrowserSharesLogins: (value) => {
          set({ agentBrowserSharesLogins: value });
        },

        setOpenTrackerLinksOnBoard: (value) => {
          set({ openTrackerLinksOnBoard: value });
        },

        setFileTreeSide: (side) => {
          set({ fileTreeSide: side === 'left' ? 'left' : 'right' });
        },

        setAutoDeleteAfterDays: (days) => {
          const clampedDays = Math.max(1, Math.min(365, days));
          set({ autoDeleteAfterDays: clampedDays });
        },

        setSessionRetentionAction: (value) => {
          set((state) => ({ sessionRetentionAction: state.sessionRetentionOnlyArchived ? 'delete' : value }));
        },

        setSessionRetentionOnlyArchived: (value) => {
          set((state) => ({
            sessionRetentionOnlyArchived: value,
            sessionRetentionAction: value ? 'delete' : state.sessionRetentionAction,
          }));
        },

        setSessionRetentionIncludeInWork: (value) => {
          set({ sessionRetentionIncludeInWork: value });
        },

        setAutoDeleteLastRunAt: (timestamp) => {
          set({ autoDeleteLastRunAt: timestamp });
        },

        setMessageLimit: (value) => {
          const clamped = Math.max(10, Math.min(500, Math.round(value)));
          set({ messageLimit: clamped });
        },

        setFontSize: (size) => {
          const clampedSize = Math.max(50, Math.min(200, size));
          set({ fontSize: clampedSize });
          get().applyTypography();
        },

        setChatFontSize: (size) => {
          set({ chatFontSize: Math.max(50, Math.min(200, Math.round(size))) });
        },

        setGlobalDraftStarters: (refs) => {
          set({ globalDraftStarters: refs });
        },

        setDraftStartersVisible: (value) => {
          set({ draftStartersVisible: value });
        },

        setTerminalFontSize: (size) => {
          const rounded = Math.round(size);
          const clamped = Math.max(9, Math.min(52, rounded));
          set({ terminalFontSize: clamped });
        },

        setTerminalShell: (shell) => {
          set({ terminalShell: shell });
        },

        setTerminalLoginShells: (shells) => {
          set({ terminalLoginShells: [...new Set(shells)] });
        },

        setTerminalCloseOnExit: (value) => {
          set({ terminalCloseOnExit: value });
        },

        setTerminalOpenOnProjectAction: (value) => {
          set({ terminalOpenOnProjectAction: value });
        },

        setEditorFontSize: (size) => {
          const rounded = Math.round(size);
          const clamped = Math.max(9, Math.min(32, rounded));
          set({ editorFontSize: clamped });
        },

        setUiFont: (font) => {
          set({ uiFont: font });
        },

        setMonoFont: (font) => {
          set({ monoFont: font });
        },

        setCustomUiFont: (family) => {
          set({ customUiFont: family.slice(0, 100) });
        },

        setCustomMonoFont: (family) => {
          set({ customMonoFont: family.slice(0, 100) });
        },

        setUiFontWeight: (weight) => {
          set({ uiFontWeight: weight });
        },

        setPadding: (size) => {
          const clampedSize = Math.max(50, Math.min(200, size));
          set({ padding: clampedSize });
          get().applyPadding();
        },

        setCornerRadius: (radius) => {
          set({ cornerRadius: radius });
        },

        applyTypography: () => {
          const { fontSize } = get();
          const root = document.documentElement;

          const scale = fontSize / 100;

          const entries = Object.entries(SEMANTIC_TYPOGRAPHY) as Array<[SemanticTypographyKey, string]>;

          if (scale === 1) {
            root.style.removeProperty('font-size');
            for (const [key] of entries) {
              root.style.removeProperty(getTypographyVariable(key));
            }
            return;
          }

          root.style.fontSize = `${scale * 100}%`;

          for (const [key] of entries) root.style.removeProperty(getTypographyVariable(key));
        },

        applyPadding: () => {
          const { padding } = get();
          const root = document.documentElement;

          const scale = padding / 100;

          if (scale === 1) {
            root.style.removeProperty('--padding-scale');
            root.style.removeProperty('--line-height-tight');
            root.style.removeProperty('--line-height-normal');
            root.style.removeProperty('--line-height-relaxed');
            root.style.removeProperty('--line-height-loose');
            return;
          }

          const adjustedScale = Math.sqrt(scale);

          root.style.setProperty('--padding-scale', adjustedScale.toString());

          const lineHeightScale = 1 + (scale - 1) * 0.15;

          root.style.setProperty('--line-height-tight', (1.25 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-normal', (1.5 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-relaxed', (1.625 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-loose', (2 * lineHeightScale).toFixed(3));
        },

        setDiffLayoutPreference: (mode) => {
          set({ diffLayoutPreference: mode });
        },

        setDiffLayoutForAllFiles: (mode) => {
          set({ diffLayoutPreference: mode, diffFileLayout: {} });
        },

        setDiffFileLayout: (filePath, mode) => {
          set((state) => ({
            diffFileLayout: {
              ...state.diffFileLayout,
              [filePath]: mode,
            },
          }));
        },

        setDiffFileListMode: (mode) => {
          set({ diffFileListMode: mode });
        },

        setDiffFileTreeWidth: (width) => {
          set({ diffFileTreeWidth: Math.round(width) });
        },

        setDiffWrapLines: (wrap) => {
          set({ diffWrapLines: wrap });
        },

        setDiffHideWhitespace: (hide) => {
          set({ diffHideWhitespace: hide });
        },

        setWalkthroughTocWidth: (width) => {
          set({ walkthroughTocWidth: Math.round(width) });
        },

        setGitChangesViewMode: (mode) => {
          set({ gitChangesViewMode: mode });
        },

        setToolJsonViewMode: (mode) => {
          set({ toolJsonViewMode: mode });
        },

        setInputBarOffset: (offset) => {
          set({ inputBarOffset: offset });
        },

        setMobileKeyboardMode: (mode) => {
          set((state) => state.mobileKeyboardMode === mode ? state : { mobileKeyboardMode: mode });
        },

        toggleFavoriteModel: (providerID, modelID) => {
          set((state) => {
            const exists = state.favoriteModels.some(
              (fav) => fav.providerID === providerID && fav.modelID === modelID
            );
            
            if (exists) {
              return {
                favoriteModels: state.favoriteModels.filter(
                  (fav) => !(fav.providerID === providerID && fav.modelID === modelID)
                ),
              };
            } else {
              return {
                favoriteModels: [{ providerID, modelID }, ...state.favoriteModels],
              };
            }
          });
        },

        reorderFavoriteModel: (activeProviderID, activeModelID, overProviderID, overModelID) => {
          set((state) => {
            const oldIndex = state.favoriteModels.findIndex(
              (fav) => fav.providerID === activeProviderID && fav.modelID === activeModelID
            );
            const newIndex = state.favoriteModels.findIndex(
              (fav) => fav.providerID === overProviderID && fav.modelID === overModelID
            );

            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
              return state;
            }

            const nextFavorites = state.favoriteModels.slice();
            const [moved] = nextFavorites.splice(oldIndex, 1);
            if (!moved) {
              return state;
            }
            nextFavorites.splice(newIndex, 0, moved);
            return { favoriteModels: nextFavorites };
          });
        },

        setProviderOrder: (orderedProviderIDs) => {
          set((state) => {
            const next = orderedProviderIDs.filter((id) => typeof id === 'string' && id.length > 0);
            const current = state.providerOrder;
            if (current.length === next.length && current.every((id, index) => id === next[index])) {
              return state;
            }
            return { providerOrder: next };
          });
        },

        setCustomProviderIcon: (providerID, icon) => {
          const normalizedProviderID = providerID.trim();
          if (!normalizedProviderID) return;
          set((state) => {
            const next = { ...state.customProviderIcons };
            if (icon) next[normalizedProviderID] = icon;
            else delete next[normalizedProviderID];
            return { customProviderIcons: next };
          });
        },

        setCustomProviderLogo: (providerID, logo) => {
          const normalizedProviderID = providerID.trim();
          if (!normalizedProviderID) return;
          set((state) => {
            const next = { ...state.customProviderLogos };
            if (logo) next[normalizedProviderID] = logo;
            else delete next[normalizedProviderID];
            return { customProviderLogos: next };
          });
        },

        toggleHiddenModel: (providerID, modelID) => {
          set((state) => {
            const exists = state.hiddenModels.some(
              (item) => item.providerID === providerID && item.modelID === modelID
            );

            if (exists) {
              return {
                hiddenModels: state.hiddenModels.filter(
                  (item) => !(item.providerID === providerID && item.modelID === modelID)
                ),
              };
            }

            return {
              hiddenModels: [{ providerID, modelID }, ...state.hiddenModels],
            };
          });
        },

        isHiddenModel: (providerID, modelID) => {
          const { hiddenModels } = get();
          return hiddenModels.some(
            (item) => item.providerID === providerID && item.modelID === modelID
          );
        },

        hideAllModels: (providerID, modelIDs) => {
          set((state) => {
            const current = state.hiddenModels.filter((item) => item.providerID !== providerID);
            const additions = modelIDs
              .filter((modelID) => typeof modelID === 'string' && modelID.length > 0)
              .map((modelID) => ({ providerID, modelID }));
            return { hiddenModels: [...additions, ...current] };
          });
        },

        showAllModels: (providerID) => {
          set((state) => ({
            hiddenModels: state.hiddenModels.filter((item) => item.providerID !== providerID),
          }));
        },

        toggleModelProviderCollapsed: (providerID) => {
          const normalizedProviderID = typeof providerID === 'string' ? providerID.trim() : '';
          if (!normalizedProviderID) {
            return;
          }

          set((state) => {
            const isCollapsed = state.collapsedModelProviders.includes(normalizedProviderID);
            if (isCollapsed) {
              return {
                collapsedModelProviders: state.collapsedModelProviders.filter((id) => id !== normalizedProviderID),
              };
            }

            return {
              collapsedModelProviders: [...state.collapsedModelProviders, normalizedProviderID],
            };
          });
        },

        setModelProvidersCollapsed: (providerIDs, collapsed) => {
          const normalizedProviderIDs = Array.from(new Set(
            providerIDs
              .filter((providerID): providerID is string => typeof providerID === 'string')
              .map((providerID) => providerID.trim())
              .filter(Boolean)
          ));

          if (normalizedProviderIDs.length === 0) {
            return;
          }

          set((state) => {
            const scopedProviderIDs = new Set(normalizedProviderIDs);
            const untouchedProviders = state.collapsedModelProviders.filter((providerID) => !scopedProviderIDs.has(providerID));

            return {
              collapsedModelProviders: collapsed
                ? [...untouchedProviders, ...normalizedProviderIDs]
                : untouchedProviders,
            };
          });
        },

        isFavoriteModel: (providerID, modelID) => {
          const { favoriteModels } = get();
          return favoriteModels.some(
            (fav) => fav.providerID === providerID && fav.modelID === modelID
          );
        },

        addRecentModel: (providerID, modelID) => {
          set((state) => {
            const filtered = state.recentModels.filter(
              (m) => !(m.providerID === providerID && m.modelID === modelID)
            );
            return {
              recentModels: [{ providerID, modelID }, ...filtered].slice(0, 5),
            };
          });
        },

        setLastSelectedModel: (providerID, modelID) => {
          const next = `${providerID}/${modelID}`;
          if (get().lastSelectedModel === next) return;
          set({ lastSelectedModel: next });
        },

        toggleFavoriteAgent: (agentName) => {
          const normalized = agentName.trim();
          if (!normalized) return;
          set((state) => ({
            favoriteAgents: state.favoriteAgents.includes(normalized)
              ? state.favoriteAgents.filter((name) => name !== normalized)
              : [...state.favoriteAgents, normalized],
          }));
        },

        addRecentAgent: (agentName) => {
          const normalized = typeof agentName === 'string' ? agentName.trim() : '';
          if (!normalized) {
            return;
          }
          set((state) => {
            if (state.recentAgents.includes(normalized)) {
              return state;
            }
            const filtered = state.recentAgents;
            return {
              recentAgents: [normalized, ...filtered].slice(0, 5),
            };
          });
        },

        addRecentEffort: (providerID, modelID, variant) => {
          const provider = providerID.trim();
          const model = modelID.trim();
          if (!provider || !model) {
            return;
          }
          const key = `${provider}/${model}`;
          const normalizedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant.trim() : 'default';
          set((state) => {
            const current = state.recentEfforts[key] ?? [];
            if (current.includes(normalizedVariant)) {
              return state;
            }
            const filtered = current;
            return {
              recentEfforts: {
                ...state.recentEfforts,
                [key]: [normalizedVariant, ...filtered].slice(0, 5),
              },
            };
          });
        },

        rememberLastUsedEffort: (providerID, modelID, variant) => {
          const provider = typeof providerID === 'string' ? providerID.trim() : '';
          const model = typeof modelID === 'string' ? modelID.trim() : '';
          if (!provider || !model) {
            return;
          }
          const key = `${provider}/${model}`;
          const normalizedVariant = variant?.trim() || null;
          set((state) => {
            if (state.lastUsedEfforts[key] === normalizedVariant) {
              return state;
            }
            const entries = Object.entries(state.lastUsedEfforts).filter(([entryKey]) => entryKey !== key);
            entries.push([key, normalizedVariant]);
            return {
              lastUsedEfforts: Object.fromEntries(entries.slice(-MAX_LAST_USED_EFFORTS)),
            };
          });
        },

        applyTheme: () => {
          const { theme } = get();
          const root = document.documentElement;

          root.classList.remove('light', 'dark');

          if (theme === 'system') {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            root.classList.add(systemTheme);
          } else {
            root.classList.add(theme);
          }
        },

        setRunOverviewKey: (runKey) => {
          set(runKey
            ? { runOverviewKey: runKey, isSessionSwitcherOpen: false, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, openGuestPageId: null }
            : { runOverviewKey: null });
        },

        requestParallelComposer: (prompt = '') => {
          set((state) => ({
            parallelComposerRequest: { id: (state.parallelComposerRequest?.id ?? 0) + 1, prompt },
            isSessionSwitcherOpen: false,
          }));
        },

        consumeParallelComposerRequest: (id) => {
          if (get().parallelComposerRequest?.id !== id) return;
          set({ parallelComposerRequest: null });
        },

        setTimelineDialogOpen: (open) => {
          set({ isTimelineDialogOpen: open });
        },

        setPromptNavigatorPanelOpen: (open) => {
          set({ isPromptNavigatorPanelOpen: open });
        },

        togglePromptNavigatorPanel: () => {
          set((state) => ({ isPromptNavigatorPanelOpen: !state.isPromptNavigatorPanelOpen }));
        },

        setImagePreviewOpen: (open) => {
          set({ isImagePreviewOpen: open });
        },

        setNativeNotificationsEnabled: (value) => {
          set({ nativeNotificationsEnabled: value });
        },

        setNotificationMode: (mode) => {
          set({ notificationMode: mode });
        },

        setShowTerminalQuickKeysOnDesktop: (value) => {
          set({ showTerminalQuickKeysOnDesktop: value });
        },

        setSessionTabsEnabled: (value) => {
          set({ sessionTabsEnabled: value });
        },

        setSessionTabsPerWorkspace: (value) => {
          set({ sessionTabsPerWorkspace: value });
        },

        setNotifyOnSubtasks: (value) => {
          set({ notifyOnSubtasks: value });
        },

        setDockBadgeEnabled: (value) => {
          set({ dockBadgeEnabled: value });
        },
        setAlwaysShowScrollbars: (value) => {
          set({ alwaysShowScrollbars: value });
        },
        setMobileKeepScreenAwake: (value) => {
          set({ mobileKeepScreenAwake: value });
        },
        setQuestionsInChat: (value) => {
          set({ questionsInChat: value });
        },

        setNotifyOnCompletion: (value) => { set({ notifyOnCompletion: value }); },
        setNotifyOnPullRequests: (value) => { set({ notifyOnPullRequests: value }); },
        setNotifyOnError: (value) => { set({ notifyOnError: value }); },
        setNotifyOnQuestion: (value) => { set({ notifyOnQuestion: value }); },
        setNotificationTemplates: (templates) => {
          set((state) => ({
            notificationTemplates: typeof templates === 'function'
              ? templates(state.notificationTemplates)
              : templates,
          }));
        },
        setSummarizeLastMessage: (value) => { set({ summarizeLastMessage: value }); },
        setSummaryThreshold: (value) => { set({ summaryThreshold: value }); },
        setSummaryLength: (value) => { set({ summaryLength: value }); },
        setMaxLastMessageLength: (value) => { set({ maxLastMessageLength: value }); },
        setShowOpenCodeUpdateNotifications: (value) => {
          set({ showOpenCodeUpdateNotifications: value });
        },
        setAgentControlToolEnabled: (value) => {
          set({ agentControlToolEnabled: value });
        },
        setAgentScheduleToolEnabled: (value) => {
          set({ agentScheduleToolEnabled: value });
        },
        setAgentWebToolEnabled: (value) => {
          set({ agentWebToolEnabled: value });
        },
        setMessageSearchEnabled: (value) => {
          set({ messageSearchEnabled: value });
        },
        setMessageSearchReasoningEnabled: (value) => {
          set({ messageSearchReasoningEnabled: value });
        },
        setBrowserProvider: (value) => {
          set({ browserProvider: value });
        },
        setAgentMemoryToolEnabled: (value) => {
          set({ agentMemoryToolEnabled: value });
        },
        setAgentKnowledgeToolEnabled: (value) => {
          set({ agentKnowledgeToolEnabled: value });
        },
        setIsolatedSpacesEnabled: (value) => {
          set({ isolatedSpacesEnabled: value });
        },
        setPermissionDefaultMode: (value) => {
          set({ permissionDefaultMode: value });
        },
        setAgentNotifyToolEnabled: (value) => {
          set({ agentNotifyToolEnabled: value });
        },
        setAgentUsageToolEnabled: (value) => {
          set({ agentUsageToolEnabled: value });
        },
        setAgentTerminalToolEnabled: (value) => {
          set({ agentTerminalToolEnabled: value });
        },
        setAgentImageToolEnabled: (value) => {
          set({ agentImageToolEnabled: value });
        },
        setAgentImageModel: (value) => {
          set({ agentImageModel: value });
        },
        setAgentMemoryDreamingEnabled: (value) => {
          set({ agentMemoryDreamingEnabled: value });
        },
        setAgentMemoryDreamingModel: (value) => {
          set({ agentMemoryDreamingModel: value });
        },
        setAgentMemoryDreamingVariant: (value) => {
          set({ agentMemoryDreamingVariant: value });
        },
        setAgentRenderToolEnabled: (value) => {
          set({ agentRenderToolEnabled: value });
        },
        setAgentSecretToolEnabled: (value) => {
          set({ agentSecretToolEnabled: value });
        },
        setAgentWorkflowToolEnabled: (value) => {
          set({ agentWorkflowToolEnabled: value });
          if (value) return;
          for (const [directory, panel] of Object.entries(get().contextPanelByDirectory)) {
            const workflowTabIds = panel.tabs.filter((tab) => tab.mode === 'workflows').map((tab) => tab.id);
            if (workflowTabIds.length > 0) get().closeContextPanelTabs(directory, workflowTabIds);
          }
        },
        setAgentMemoryFeatureAvailable: (value) => {
          set({ agentMemoryFeatureAvailable: value });
        },
        setAgentWorkflowFeatureAvailable: (value) => {
          set({ agentWorkflowFeatureAvailable: value });
        },
        setRoutingFeatureAvailable: (value) => {
          set({ routingFeatureAvailable: value });
        },
        setOverviewFeatureAvailable: (value) => {
          set(value ? { overviewFeatureAvailable: true } : { overviewFeatureAvailable: false, isOverviewOpen: false });
        },
        markAgentMemoryViewed: (key, viewedAt) => {
          set((state) => ({
            agentMemoryViewedAt: viewedAt > (state.agentMemoryViewedAt[key] ?? 0)
              ? { ...state.agentMemoryViewedAt, [key]: viewedAt }
              : state.agentMemoryViewedAt,
          }));
        },
        setProjectContextTab: (value) => {
          set({ projectContextTab: value });
        },
        openProjectKnowledgePlan: (directory, projectContextId, planId) => {
          set({ projectContextTab: 'plans', projectKnowledgePlanRequest: { projectContextId, planId } });
          get().openContextPanelTab(directory, { mode: 'notes' });
        },
        clearProjectKnowledgePlanRequest: () => {
          set({ projectKnowledgePlanRequest: null });
        },
        setInputSpellcheckEnabled: (value) => {
          set({ inputSpellcheckEnabled: value });
        },
        setLargeTextPasteBehavior: (value) => {
          set({ largeTextPasteBehavior: normalizeLargeTextPasteBehavior(value) });
        },
        setEnterToSend: (value) => {
          set({ enterToSend: value });
        },
        setEnterToSendConfigured: (value) => {
          set({ enterToSendConfigured: value });
        },
        setMobileReturnKeySends: (value) => {
          set({ mobileReturnKeySends: value });
        },
        setChatWidth: (value) => {
          set({ chatWidth: value });
        },
        setCodeBlockLineWrap: (value) => {
          set({ codeBlockLineWrap: value });
        },
        setTableCellWrap: (value) => {
          set({ tableCellWrap: value });
        },
        setSelectionApprovalText: (value) => {
          set({ selectionApprovalText: value });
        },
        setCopyMessagesAsPlainText: (value) => {
          set({ copyMessagesAsPlainText: value });
        },
        setShowToolFileIcons: (value) => {
          set({ showToolFileIcons: value });
        },
        setShowTurnChangedFiles: (value) => {
          set({ showTurnChangedFiles: value });
        },

        setTimeFormatPreference: (value) => {
          set({ timeFormatPreference: value });
        },

        setWeekStartPreference: (value) => {
          set({ weekStartPreference: value });
        },
        setDesktopWindowControlsPosition: (value) => {
          set({ desktopWindowControlsPosition: value === 'left' ? 'left' : 'right' });
        },
        setDesktopWindowControlsStyle: (value) => {
          set({ desktopWindowControlsStyle: value === 'traffic-lights' ? 'traffic-lights' : 'classic' });
        },
        setMermaidRenderingMode: (value) => {
          set({ mermaidRenderingMode: value });
        },
        setUserMessageRenderingMode: (value) => {
          set({ userMessageRenderingMode: value });
        },
        setCollapsibleUserMessages: (value) => {
          set({ collapsibleUserMessages: value });
        },
        setStickyUserHeader: (value) => {
          set({ stickyUserHeader: value });
        },
        setPromptNavigatorEnabled: (value) => {
          set({ promptNavigatorEnabled: value });
        },
        setShowSplitAssistantMessageActions: (value) => {
          set({ showSplitAssistantMessageActions: value });
        },
        setAllowPromptingSubagentSessions: (value) => {
          set({ allowPromptingSubagentSessions: value });
        },
        setSavePastedImagesAsFiles: (value) => {
          set({ savePastedImagesAsFiles: value });
        },
        setReportUsage: (value) => {
          set({ reportUsage: value });
        },
        viewPagerPage: 'center',
        setViewPagerPage: (page: 'left' | 'center' | 'right') => {
          set({ viewPagerPage: page });
          set({ isSessionSwitcherOpen: page === 'left' });
        },

        setShortcutOverride: (actionId, combo) => {
          set((state) => ({
            shortcutOverrides: {
              ...state.shortcutOverrides,
              [actionId]: combo,
            },
          }));
        },

        clearShortcutOverride: (actionId) => {
          set((state) => {
            const rest = { ...state.shortcutOverrides };
            delete rest[actionId];
            return { shortcutOverrides: rest };
          });
        },

        resetAllShortcutOverrides: () => {
          set({ shortcutOverrides: {} });
        },

        setFileEditorKeymap: (value) => {
          set({ fileEditorKeymap: normalizeFileEditorKeymap(value) });
        },

        setFileEditorVimMappings: (value) => {
          set({ fileEditorVimMappings: value.slice(0, 10_000) });
        },

        toggleExpandedInput: () => {
          set((state) => ({ isExpandedInput: !state.isExpandedInput }));
        },

        setExpandedInput: (value) => {
          set({ isExpandedInput: value });
        },
      }),
      {
        name: 'ui-store',
        storage: createDeferredSafeJSONStorage(),
        version: 30,
        migrate: (persistedState, version) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return persistedState;
          }
          const state = persistedState as Record<string, unknown>;

          if (version < 23) {
            state.tableCellWrap = true;
          }

          if (version < 27 && Array.isArray(state.workStatusSectionOrder)) {
            state.workStatusSectionOrder = sanitizeWorkStatusSectionOrder(state.workStatusSectionOrder, false);
          }

          if (version < 28 && state.editorFontSize === 13) {
            state.editorFontSize = DEFAULT_EDITOR_FONT_SIZE;
          }

          if (version < 29 && state.contextEditorTreeWidth === 240) {
            state.contextEditorTreeWidth = DEFAULT_CONTEXT_EDITOR_TREE_WIDTH;
          }

          if (version < 30) {
            state.chatWidth = state.wideChatLayoutEnabled === true ? 'full' : 'default';
            delete state.wideChatLayoutEnabled;
          }

          if (version < 21 && state.workStatusHiddenSectionsExplicit !== true) {
            state.workStatusHiddenSections = Array.isArray(state.workStatusHiddenSections)
              ? state.workStatusHiddenSections.filter((id) => id !== 'telemetry')
              : [];
            state.workStatusHiddenSectionsExplicit = false;
          }

          if (version < 16) {
            delete state.activeMainTab;
            delete state.activeSurface;
          }

          if (version < 17) {
            delete state.expandedEditorToolbar;
          }

          if (version < 18) {
            delete state.shortcutOverrides;
          }

          if (version < 14) {
            const byDirectory = state.contextPanelByDirectory;
            if (byDirectory && typeof byDirectory === 'object') {
              for (const directoryState of Object.values(byDirectory as Record<string, unknown>)) {
                if (!directoryState || typeof directoryState !== 'object') continue;
                const entry = directoryState as Record<string, unknown>;

                const widths = entry.widthByMode;
                if (widths && typeof widths === 'object') {
                  const widthRecord = widths as Record<string, unknown>;
                  if (widthRecord.preview !== undefined) {
                    if (widthRecord.browser === undefined) widthRecord.browser = widthRecord.preview;
                    delete widthRecord.preview;
                  }
                }

                if (!Array.isArray(entry.tabs)) continue;
                const seenIds = new Set<string>();
                const migrated: Array<Record<string, unknown>> = [];
                for (const rawTab of entry.tabs as Array<unknown>) {
                  if (!rawTab || typeof rawTab !== 'object') continue;
                  const tab = rawTab as Record<string, unknown>;
                  if (tab.mode !== 'preview') {
                    if (typeof tab.id === 'string') seenIds.add(tab.id);
                    migrated.push(tab);
                    continue;
                  }

                  const targetPath = typeof tab.targetPath === 'string' ? tab.targetPath : '';
                  const dedupeKey = typeof tab.dedupeKey === 'string' && tab.dedupeKey.trim()
                    ? tab.dedupeKey.trim()
                    : (targetPath || 'browser');
                  const id = dedupeKey === 'browser' ? 'browser' : `browser:${dedupeKey}`;
                  if (seenIds.has(id)) continue;
                  seenIds.add(id);
                  migrated.push({ ...tab, mode: 'browser', id, dedupeKey });
                }
                entry.tabs = migrated;

                if (typeof entry.activeTabId === 'string' && entry.activeTabId.startsWith('preview')) {
                  const nextActive = migrated.find((tab) => typeof tab.id === 'string');
                  entry.activeTabId = nextActive && typeof nextActive.id === 'string' ? nextActive.id : null;
                }
              }
            }
          }

          if (version < 13) {
            if (typeof state.autoSaveEnabled !== 'boolean') {
              let legacyEnabled = true;
              try {
                if (typeof localStorage !== 'undefined') {
                  const legacy = localStorage.getItem('openchamber:files:auto-save-enabled');
                  if (legacy !== null) {
                    legacyEnabled = legacy !== 'false';
                    localStorage.removeItem('openchamber:files:auto-save-enabled');
                  }
                }
              } catch {
                legacyEnabled = true;
              }
              state.autoSaveEnabled = legacyEnabled;
            }
          }

          if (version < 12) {
            if (state.desktopWindowControlsPosition === 'auto' || state.desktopWindowControlsPosition == null) {
              state.desktopWindowControlsPosition = 'right';
            }
          }

          if (version < 11 && state.terminalFontSize === 13) {
            state.terminalFontSize = 14;
          }

          if (version < 10) {
            delete state.diffViewMode;
          }

          if (version < 9) {
            if (!state.workStatusExpandedSections || typeof state.workStatusExpandedSections !== 'object') {
              state.workStatusExpandedSections = {};
            }
            if (typeof state.workStatusScrollTop !== 'number' || !Number.isFinite(state.workStatusScrollTop)) {
              state.workStatusScrollTop = 0;
            }
            if (typeof state.workStatusPanelEnabled !== 'boolean') {
              state.workStatusPanelEnabled = true;
            }
            if (!Array.isArray(state.workStatusHiddenSections)) {
              state.workStatusHiddenSections = [];
            }
          }

          if (version < 1) {
            if (isLegacyDefaultTemplates(state.notificationTemplates)) {
              state.notificationTemplates = {
                completion: { ...EMPTY_NOTIFICATION_TEMPLATES.completion },
                error: { ...EMPTY_NOTIFICATION_TEMPLATES.error },
                question: { ...EMPTY_NOTIFICATION_TEMPLATES.question },
                subtask: { ...EMPTY_NOTIFICATION_TEMPLATES.subtask },
              };
            }
          }

          if (version < 3) {
            const OLD_DEFAULTS = new Set([90, 120, 180, 220]);
            const hist = state.memoryLimitHistorical as number | undefined;
            const active = state.memoryLimitActiveSession as number | undefined;

            if (typeof hist === 'number' && !OLD_DEFAULTS.has(hist)) {
              state.messageLimit = hist;
            } else if (typeof active === 'number' && !OLD_DEFAULTS.has(active)) {
              state.messageLimit = active;
            }

            delete state.memoryLimitHistorical;
            delete state.memoryLimitViewport;
            delete state.memoryLimitActiveSession;
          }

          delete state.isRightSidebarOpen;
          delete state.rightSidebarWidth;
          delete state.rightSidebarTab;

          const legacySizes: LegacyZoneSizes[] = [];
          state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory, legacySizes);
          if (version < 26) {
            const latest = legacySizes
              .filter((entry) => Object.keys(entry.sizes).length > 0)
              .sort((a, b) => b.touchedAt - a.touchedAt)[0];
            state.contextZoneSizes = latest?.sizes ?? {};
          }

          if (version < 5) {
            if (!state.shortcutOverrides || typeof state.shortcutOverrides !== 'object') {
              state.shortcutOverrides = {};
            } else {
              const overrides = state.shortcutOverrides as Record<string, unknown>;
              const cleaned: Record<string, string> = {};
              for (const [key, value] of Object.entries(overrides)) {
                if (typeof key === 'string' && typeof value === 'string') {
                  cleaned[key] = value;
                }
              }
              state.shortcutOverrides = cleaned;
            }
          }

          if (version < 6) {
            state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory);
          }

          if (version < 7) {
            state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory);
          }

          if (version < 8) {
            if (state.gitChangesViewMode !== 'flat' && state.gitChangesViewMode !== 'tree') {
              state.gitChangesViewMode = 'flat';
            }
          }

          delete state.linearIssueListStatus;
          delete state.linearIssueListAssignee;
          delete state.linearIssueListTeamId;
          delete state.linearIssueListTeamIdByRuntime;
          delete state.linearIssueListPriority;

          state.fileEditorKeymap = normalizeFileEditorKeymap(state.fileEditorKeymap);
          state.largeTextPasteBehavior = normalizeLargeTextPasteBehavior(state.largeTextPasteBehavior);

          if (state.toolJsonViewMode !== 'summary'
            && state.toolJsonViewMode !== 'formatted'
            && state.toolJsonViewMode !== 'raw') {
            state.toolJsonViewMode = 'summary';
          }

          if (typeof state.autoSaveEnabled !== 'boolean') {
            state.autoSaveEnabled = true;
          }

          state.contextRailHiddenSurfaces = Array.isArray(state.contextRailHiddenSurfaces)
            ? (state.contextRailHiddenSurfaces as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          state.contextRailOrder = Array.isArray(state.contextRailOrder)
            ? (state.contextRailOrder as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          for (const key of ['mobileWorkspaceTabOrder', 'mobileWorkspaceHiddenTabs']) {
            const value = state[key];
            state[key] = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
          }

          state.contextSurfaceZones = zonePlacementSchema.parse(state.contextSurfaceZones);

          return state;
        },
        partialize: (state) => ({
          theme: state.theme,
          isSidebarOpen: state.isSidebarOpen,
          sidebarFoldedForExpandedZone: state.sidebarFoldedForExpandedZone,
          sidebarWidth: state.sidebarWidth,
          contextPanelByDirectory: withoutForeignComparisons(state.contextPanelByDirectory),
          contextRailOrder: state.contextRailOrder,
          contextRailHiddenSurfaces: state.contextRailHiddenSurfaces,
          mobileWorkspaceTabOrder: state.mobileWorkspaceTabOrder,
          mobileWorkspaceHiddenTabs: state.mobileWorkspaceHiddenTabs,
          mobileWorkStatusHiddenSections: state.mobileWorkStatusHiddenSections,
          contextSurfaceZones: state.contextSurfaceZones,
          contextEditorTreeVisible: state.contextEditorTreeVisible,
          fileTreeSide: state.fileTreeSide,
          contextEditorVisible: state.contextEditorVisible,
          contextEditorTreeWidth: state.contextEditorTreeWidth,
          contextZoneSizes: state.contextZoneSizes,
          contextZoneExpandedChatSizes: state.contextZoneExpandedChatSizes,
          workStatusExpandedSections: state.workStatusExpandedSections,
          messageQueueExpanded: state.messageQueueExpanded,
          workStatusScrollTop: state.workStatusScrollTop,
          workStatusPanelEnabled: state.workStatusPanelEnabled,
          workStatusHiddenSections: state.workStatusHiddenSections,
          workStatusSectionOrder: state.workStatusSectionOrder,
          workStatusSectionOrderExplicit: state.workStatusSectionOrderExplicit,
          workStatusHiddenSectionsExplicit: state.workStatusHiddenSectionsExplicit,
          isSessionSwitcherOpen: state.isSessionSwitcherOpen,
          sidebarSection: state.sidebarSection,
          settingsPage: state.settingsPage,
          settingsHasOpenedOnce: state.settingsHasOpenedOnce,
          settingsProjectsSelectedId: state.settingsProjectsSelectedId,
          settingsRemoteInstancesSelectedId: state.settingsRemoteInstancesSelectedId,
          isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
          showReasoningTraces: state.showReasoningTraces,
          streamingAutoFollowEnabled: state.streamingAutoFollowEnabled,
          sessionRecapEnabled: state.sessionRecapEnabled,
          sessionSuggestionEnabled: state.sessionSuggestionEnabled,
          sessionWorkEnabled: state.sessionWorkEnabled,
          sessionReviewOfferEnabled: state.sessionReviewOfferEnabled,
          sessionGoalEnabled: state.sessionGoalEnabled,
          sessionGoalChecker: state.sessionGoalChecker,
          sessionGoalMaxAutoTurns: state.sessionGoalMaxAutoTurns,
          sessionGoalDefaultBudgetEnabled: state.sessionGoalDefaultBudgetEnabled,
          sessionGoalDefaultBudget: state.sessionGoalDefaultBudget,
          collapsibleThinkingBlocks: state.collapsibleThinkingBlocks,
          expandReasoningWhileStreaming: state.expandReasoningWhileStreaming,
          activityRenderMode: state.activityRenderMode,
          showDeletionDialog: state.showDeletionDialog,
          autoDeleteEnabled: state.autoDeleteEnabled,
          autoSaveEnabled: state.autoSaveEnabled,
          fileEditorWrapLines: state.fileEditorWrapLines,
          confirmFileTreeMove: state.confirmFileTreeMove,
          layoutAnimations: state.layoutAnimations,
          openLinksInBrowserPanel: state.openLinksInBrowserPanel,
          liveBrowserTabLimit: state.liveBrowserTabLimit,
          agentBrowserSharesLogins: state.agentBrowserSharesLogins,
          openTrackerLinksOnBoard: state.openTrackerLinksOnBoard,
          autoDeleteAfterDays: state.autoDeleteAfterDays,
          sessionRetentionAction: state.sessionRetentionAction,
          sessionRetentionOnlyArchived: state.sessionRetentionOnlyArchived,
          sessionRetentionIncludeInWork: state.sessionRetentionIncludeInWork,
          mergedWorktreeCleanupEnabled: state.mergedWorktreeCleanupEnabled,
          worktreeArchiveOnDoneEnabled: state.worktreeArchiveOnDoneEnabled,
          autoDeleteLastRunAt: state.autoDeleteLastRunAt,
          messageLimit: state.messageLimit,
          fontSize: state.fontSize,
          chatFontSize: state.chatFontSize,
          globalDraftStarters: state.globalDraftStarters,
          terminalFontSize: state.terminalFontSize,
          terminalShell: state.terminalShell,
          terminalLoginShells: state.terminalLoginShells,
          terminalCloseOnExit: state.terminalCloseOnExit,
          terminalOpenOnProjectAction: state.terminalOpenOnProjectAction,
          editorFontSize: state.editorFontSize,
          uiFont: state.uiFont,
          monoFont: state.monoFont,
          customUiFont: state.customUiFont,
          customMonoFont: state.customMonoFont,
          uiFontWeight: state.uiFontWeight,
          padding: state.padding,
          cornerRadius: state.cornerRadius,
          favoriteModels: state.favoriteModels,
          hiddenModels: state.hiddenModels,
          providerOrder: state.providerOrder,
          collapsedModelProviders: state.collapsedModelProviders,
          customProviderIcons: state.customProviderIcons,
          customProviderLogos: state.customProviderLogos,
          recentModels: state.recentModels,
          lastSelectedModel: state.lastSelectedModel,
          recentAgents: state.recentAgents,
          favoriteAgents: state.favoriteAgents,
          recentEfforts: state.recentEfforts,
          lastUsedEfforts: state.lastUsedEfforts,
          diffLayoutPreference: state.diffLayoutPreference,
          diffWrapLines: state.diffWrapLines,
          diffHideWhitespace: state.diffHideWhitespace,
          diffFileListMode: state.diffFileListMode,
          diffFileTreeWidth: state.diffFileTreeWidth,
          walkthroughTocWidth: state.walkthroughTocWidth,
          gitChangesViewMode: state.gitChangesViewMode,
          toolJsonViewMode: state.toolJsonViewMode,
          nativeNotificationsEnabled: state.nativeNotificationsEnabled,
          notificationMode: state.notificationMode,
          showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
          sessionTabsEnabled: state.sessionTabsEnabled,
          sessionTabsPerWorkspace: state.sessionTabsPerWorkspace,
          notifyOnSubtasks: state.notifyOnSubtasks,
          dockBadgeEnabled: state.dockBadgeEnabled,
          alwaysShowScrollbars: state.alwaysShowScrollbars,
          mobileKeepScreenAwake: state.mobileKeepScreenAwake,
          questionsInChat: state.questionsInChat,
          notifyOnCompletion: state.notifyOnCompletion,
          notifyOnPullRequests: state.notifyOnPullRequests,
          notifyOnError: state.notifyOnError,
          notifyOnQuestion: state.notifyOnQuestion,
          notificationTemplates: state.notificationTemplates,
          summarizeLastMessage: state.summarizeLastMessage,
          summaryThreshold: state.summaryThreshold,
          summaryLength: state.summaryLength,
          maxLastMessageLength: state.maxLastMessageLength,
          showOpenCodeUpdateNotifications: state.showOpenCodeUpdateNotifications,
          agentControlToolEnabled: state.agentControlToolEnabled,
          agentScheduleToolEnabled: state.agentScheduleToolEnabled,
          agentWebToolEnabled: state.agentWebToolEnabled,
          messageSearchEnabled: state.messageSearchEnabled,
          messageSearchReasoningEnabled: state.messageSearchReasoningEnabled,
          browserProvider: state.browserProvider,
          agentMemoryToolEnabled: state.agentMemoryToolEnabled,
          agentKnowledgeToolEnabled: state.agentKnowledgeToolEnabled,
          agentNotifyToolEnabled: state.agentNotifyToolEnabled,
          agentUsageToolEnabled: state.agentUsageToolEnabled,
          agentTerminalToolEnabled: state.agentTerminalToolEnabled,
          agentImageToolEnabled: state.agentImageToolEnabled,
          agentImageModel: state.agentImageModel,
          agentMemoryDreamingEnabled: state.agentMemoryDreamingEnabled,
          agentMemoryDreamingModel: state.agentMemoryDreamingModel,
          agentMemoryDreamingVariant: state.agentMemoryDreamingVariant,
          agentRenderToolEnabled: state.agentRenderToolEnabled,
          agentSecretToolEnabled: state.agentSecretToolEnabled,
          agentWorkflowToolEnabled: state.agentWorkflowToolEnabled,
          isolatedSpacesEnabled: state.isolatedSpacesEnabled,
          permissionDefaultMode: state.permissionDefaultMode,
          agentMemoryViewedAt: state.agentMemoryViewedAt,
          inputSpellcheckEnabled: state.inputSpellcheckEnabled,
          largeTextPasteBehavior: state.largeTextPasteBehavior,
          enterToSend: state.enterToSend,
          enterToSendConfigured: state.enterToSendConfigured,
          mobileReturnKeySends: state.mobileReturnKeySends,
          chatWidth: state.chatWidth,
          codeBlockLineWrap: state.codeBlockLineWrap,
          tableCellWrap: state.tableCellWrap,
          copyMessagesAsPlainText: state.copyMessagesAsPlainText,
          selectionApprovalText: state.selectionApprovalText,
          showToolFileIcons: state.showToolFileIcons,
          showTurnChangedFiles: state.showTurnChangedFiles,
          timeFormatPreference: state.timeFormatPreference,
          weekStartPreference: state.weekStartPreference,
          desktopWindowControlsPosition: state.desktopWindowControlsPosition,
          desktopWindowControlsStyle: state.desktopWindowControlsStyle,
          inputBarOffset: state.inputBarOffset,
          mermaidRenderingMode: state.mermaidRenderingMode,
          userMessageRenderingMode: state.userMessageRenderingMode,
          collapsibleUserMessages: state.collapsibleUserMessages,
          stickyUserHeader: state.stickyUserHeader,
          promptNavigatorEnabled: state.promptNavigatorEnabled,
          showSplitAssistantMessageActions: state.showSplitAssistantMessageActions,
          allowPromptingSubagentSessions: state.allowPromptingSubagentSessions,
          savePastedImagesAsFiles: state.savePastedImagesAsFiles,
          draftStartersVisible: state.draftStartersVisible,
          shortcutOverrides: state.shortcutOverrides,
          fileEditorKeymap: state.fileEditorKeymap,
          fileEditorVimMappings: state.fileEditorVimMappings,
        })
      }
    ),
    {
      name: 'ui-store'
    }
  )
);
