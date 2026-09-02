import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { SidebarSection } from '@/constants/sidebar';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '@/lib/typography';
import type { ShortcutCombo } from '@/lib/shortcuts';
import type { DraftStarterRef } from '@/lib/draftStarters';
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { getStoredMobileKeyboardMode, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { LinearIssueListAssignee, LinearIssueListPriority, LinearIssueListStatus, TerminalShell } from '@/lib/api/types';
import type { ProjectRef } from '@/lib/projectContextApi';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { isWindowsArm64 } from '@/lib/platform';
import { isVSCodeRuntime } from '@/lib/desktop';

export type PendingDiffScope = 'working' | 'staged' | 'turn' | 'branch';
export type ContextPanelMode = 'diff' | 'walkthrough' | 'file' | 'context' | 'plan' | 'chat' | 'browser' | 'git' | 'pr' | 'linear' | 'notes' | 'terminal';
export type MermaidRenderingMode = 'svg' | 'ascii';
export type UserMessageRenderingMode = 'markdown' | 'plain';
export type ChatRenderMode = 'sorted' | 'live';
export type ActivityRenderMode = 'collapsed' | 'summary';
export type SessionRetentionAction = 'archive' | 'delete';
export type TimeFormatPreference = 'auto' | '12h' | '24h';
export type WeekStartPreference = 'auto' | 'sunday' | 'monday';
export type DesktopWindowControlsPosition = 'left' | 'right';
export type DesktopWindowControlsStyle = 'classic' | 'traffic-lights';
export type FileEditorKeymap = 'default' | 'vim';
export type LargeTextPasteBehavior = 'ask' | 'attach' | 'inline';

export const DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR: LargeTextPasteBehavior = 'ask';

export const normalizeLargeTextPasteBehavior = (value: unknown): LargeTextPasteBehavior => {
  if (value === 'attach' || value === 'inline' || value === 'ask') {
    return value;
  }
  return DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR;
};

function normalizeFileEditorKeymap(value: unknown): FileEditorKeymap {
  return value === 'vim' ? 'vim' : 'default';
}

export const LINEAR_ISSUE_LIST_ALL_TEAMS = 'all';

function sanitizeLinearIssueListStatus(value: unknown): LinearIssueListStatus {
  return value === 'all'
    || value === 'backlog'
    || value === 'todo'
    || value === 'started'
    || value === 'inReview'
    || value === 'completed'
    || value === 'canceled'
    || value === 'duplicate'
    ? value
    : 'all';
}

function sanitizeLinearIssueListAssignee(value: unknown): LinearIssueListAssignee {
  return value === 'me' || value === 'any' ? value : 'any';
}

function sanitizeLinearIssueListTeamId(value: unknown): string {
  if (typeof value !== 'string') return LINEAR_ISSUE_LIST_ALL_TEAMS;
  const teamId = value.trim();
  return teamId || LINEAR_ISSUE_LIST_ALL_TEAMS;
}

function sanitizeLinearIssueListPriority(value: unknown): LinearIssueListPriority {
  return value === 'none' || value === 'urgent' || value === 'high' || value === 'medium' || value === 'low' || value === 'all'
    ? value
    : 'all';
}

type ContextPanelTab = {
  id: string;
  mode: ContextPanelMode;
  targetPath: string | null;
  /** Saved project plan this tab shows, for `plan` tabs opened from the notes
      panel. Project plans are addressed by id because their markdown is
      server-owned and has no client-visible path. */
  projectPlanId: string | null;
  /** The project that owns `projectPlanId`. Persisted with the tab so a
      restored plan tab opens against its own project instead of guessing the
      owner from whatever directory happens to be current. */
  projectPlanRef: ProjectRef | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: PendingDiffScope | null;
  touchedAt: number;
};

type ContextPanelTabDescriptor = {
  mode: ContextPanelMode;
  targetPath?: string | null;
  projectPlanId?: string | null;
  projectPlanRef?: ProjectRef | null;
  dedupeKey?: string | null;
  label?: string | null;
  sessionTitleFallback?: string | null;
  readOnly?: boolean;
  stagedDiff?: boolean;
  diffScope?: PendingDiffScope | null;
};

type ContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  tabs: ContextPanelTab[];
  activeTabId: string | null;
  // Manual per-surface widths (px), populated only by user resize; surfaces
  // without an entry fall back to their registry defaultWidthFraction.
  widthByMode: Partial<Record<ContextPanelMode, number>>;
  touchedAt: number;
};

type PendingFileNavigation = {
  path: string;
  line: number;
  column: number;
};

export type EventStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'paused'
  | 'offline'
  | 'error';

const LEGACY_DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{last_message}' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: '{agent_name} needs input', message: '{last_message}' },
  subtask: { title: 'Subtask complete', message: '{last_message}' },
} as const;

const EMPTY_NOTIFICATION_TEMPLATES = {
  completion: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  subtask: { title: '', message: '' },
} as const;

const isSameTemplateValue = (
  a: { title: string; message: string } | undefined,
  b: { title: string; message: string }
) => {
  if (!a) return false;
  return a.title === b.title && a.message === b.message;
};

const isLegacyDefaultTemplates = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, { title: string; message: string } | undefined>;
  return (
    isSameTemplateValue(candidate.completion, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.completion)
    && isSameTemplateValue(candidate.error, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.error)
    && isSameTemplateValue(candidate.question, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.question)
    && isSameTemplateValue(candidate.subtask, LEGACY_DEFAULT_NOTIFICATION_TEMPLATES.subtask)
  );
};

const CONTEXT_PANEL_DEFAULT_WIDTH = 380;
const CONTEXT_PANEL_MIN_WIDTH = 380;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
/** Per surface, not per panel: see clampContextPanelTabs. */
const CONTEXT_PANEL_MAX_TABS = 12;
const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;
const LEFT_SIDEBAR_MIN_WIDTH = 280;
/** Separates browser tabs opened in the same millisecond. */
let browserTabSequence = 0;

// Shared with rail/panel consumers so contextPanelByDirectory lookups agree on keys.
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
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const normalizeContextTargetPath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/');
};

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
  return value === 'working' || value === 'staged' || value === 'turn' || value === 'branch' ? value : null;
};

/** A plan tab's owner must be a complete project reference or nothing; a
    half-valid one is worse than none because it points the editor somewhere. */
const normalizeContextPanelProjectPlanRef = (value: unknown): ProjectRef | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as { id?: unknown; path?: unknown };
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
  return id && path ? { id, path } : null;
};

const buildDefaultContextPanelTabDedupeKey = (mode: ContextPanelMode, targetPath: string | null): string => {
  if (mode === 'file') {
    return targetPath || mode;
  }

  if (mode === 'browser') {
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

const createContextPanelTab = (descriptor: ContextPanelTabDescriptor): ContextPanelTab => {
  const normalizedTargetPath = normalizeContextTargetPath(descriptor.targetPath);
  const dedupeKey = normalizeContextPanelTabDedupeKey(
    descriptor.mode,
    normalizedTargetPath,
    descriptor.dedupeKey,
  );
  return {
    id: buildContextPanelTabID(descriptor.mode, dedupeKey),
    mode: descriptor.mode,
    targetPath: normalizedTargetPath,
    projectPlanId: typeof descriptor.projectPlanId === 'string' && descriptor.projectPlanId.trim()
      ? descriptor.projectPlanId.trim()
      : null,
    projectPlanRef: normalizeContextPanelProjectPlanRef(descriptor.projectPlanRef),
    dedupeKey,
    label: normalizeContextTabLabel(descriptor.label),
    sessionTitleFallback: normalizeContextTabLabel(descriptor.sessionTitleFallback),
    readOnly: descriptor.readOnly === true,
    stagedDiff: descriptor.stagedDiff === true,
    diffScope: normalizePendingDiffScope(descriptor.diffScope) ?? (descriptor.stagedDiff === true ? 'staged' : 'working'),
    touchedAt: Date.now(),
  };
};

/**
 * Keeps each surface's tab count in hand.
 *
 * The limit is per mode because the strip is per mode: a user looking at diffs
 * only ever sees diff tabs, so evicting one to make room for a browser tab
 * takes away something they cannot see being taken. Modes compete for screen
 * space separately, so they get separate budgets.
 */
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
      .filter((tab) => tab.id !== activeTabId);
    // Never drop the tab being opened or looked at; if that leaves the mode one
    // over its budget, one extra tab beats losing the one in use.
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
      projectPlanId?: unknown;
      projectPlanRef?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
      sessionTitleFallback?: unknown;
      readOnly?: unknown;
      stagedDiff?: unknown;
      diffScope?: unknown;
      touchedAt?: unknown;
    };

    // Legacy 'preview' tabs are converted to 'browser' by the v14 migration;
    // anything still carrying an unknown mode here is discarded rather than
    // resurrected into a tab the panel cannot render.
    if (candidate.mode !== 'diff' && candidate.mode !== 'walkthrough' && candidate.mode !== 'file' && candidate.mode !== 'context' && candidate.mode !== 'plan' && candidate.mode !== 'chat' && candidate.mode !== 'browser' && candidate.mode !== 'git' && candidate.mode !== 'pr' && candidate.mode !== 'linear' && candidate.mode !== 'notes' && candidate.mode !== 'terminal') {
      continue;
    }

    // State is shared with the desktop and web surfaces, which do have a
    // browser; inside VS Code such a tab would have no surface to belong to.
    if (dropBrowserTabs && candidate.mode === 'browser') {
      continue;
    }

    const targetPath = normalizeContextTargetPath(typeof candidate.targetPath === 'string' ? candidate.targetPath : null);
    const projectPlanId = typeof candidate.projectPlanId === 'string' && candidate.projectPlanId.trim()
      ? candidate.projectPlanId.trim()
      : null;
    const projectPlanRef = normalizeContextPanelProjectPlanRef(candidate.projectPlanRef);
    // `mode: 'plan'` covers two documents: a saved Project knowledge plan
    // (needs both the plan id and its owning project) and a plain session
    // filesystem plan (has neither). Only the half-identified form — id
    // without owner — is unopenable: the editor would have to guess the
    // project from the current directory, which is exactly the bug that made
    // saved plans open empty. Such tabs are dropped rather than resurrected.
    if (candidate.mode === 'plan' && (projectPlanId !== null) !== (projectPlanRef !== null)) {
      continue;
    }
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
      projectPlanId,
      projectPlanRef,
      dedupeKey,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
      sessionTitleFallback: normalizeContextTabLabel(typeof candidate.sessionTitleFallback === 'string' ? candidate.sessionTitleFallback : null),
      readOnly: candidate.readOnly === true,
      stagedDiff: candidate.stagedDiff === true,
      diffScope: normalizePendingDiffScope(candidate.diffScope) ?? (candidate.stagedDiff === true ? 'staged' : 'working'),
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

const touchContextPanelState = (prev?: ContextPanelDirectoryState): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    const activeTabId = resolveActiveContextPanelTabID(tabs, prev.activeTabId);
    return {
      ...prev,
      tabs,
      activeTabId,
      touchedAt: Date.now(),
    };
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    widthByMode: {},
    touchedAt: Date.now(),
  };
};

const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
  options?: { reveal?: boolean },
): ContextPanelDirectoryState => {
  const reveal = options?.reveal !== false;
  const nextTab = createContextPanelTab(descriptor);
  // A real file tab replaces the empty editor placeholder ('file' with no
  // target) that the rail can open before any file is picked.
  const baseTabs = nextTab.mode === 'file' && nextTab.targetPath
    ? current.tabs.filter((tab) => !(tab.mode === 'file' && !tab.targetPath))
    : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  const tabs = existingIndex === -1
    ? [...baseTabs, nextTab]
     : baseTabs.map((tab, index) => (index === existingIndex
       ? {
           ...tab,
           mode: nextTab.mode,
           targetPath: nextTab.targetPath || tab.targetPath,
           projectPlanId: nextTab.projectPlanId ?? tab.projectPlanId,
           projectPlanRef: nextTab.projectPlanRef ?? tab.projectPlanRef,
           dedupeKey: nextTab.dedupeKey,
           label: nextTab.label,
           sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
           stagedDiff: nextTab.stagedDiff,
           diffScope: nextTab.diffScope,
           readOnly: nextTab.readOnly,
           touchedAt: Date.now(),
         }
       : tab));

  // A background upsert (an agent working a page) keeps the panel exactly as
  // the user left it: closed stays closed, and whatever tab they were on
  // stays active. The tab still exists — panes are kept mounted regardless of
  // visibility — so agent control and a later manual open both find it.
  const activeTabId = reveal
    ? nextTab.id
    : current.activeTabId ?? nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return {
    ...current,
    isOpen: reveal ? true : current.isOpen,
    tabs: clampedTabs,
    activeTabId: resolveActiveContextPanelTabID(clampedTabs, activeTabId),
    touchedAt: Date.now(),
  };
};

const closeContextPanelTabs = (
  current: ContextPanelDirectoryState,
  tabIds: readonly string[],
): ContextPanelDirectoryState => {
  const closed = new Set(tabIds);
  const closedTabs = current.tabs.filter((tab) => closed.has(tab.id));
  const nextTabs = current.tabs.filter((tab) => !closed.has(tab.id));
  if (nextTabs.length === current.tabs.length) {
    return current;
  }

  const activeClosed = current.activeTabId ? closed.has(current.activeTabId) : false;
  if (!activeClosed) {
    return {
      ...current,
      tabs: nextTabs,
      activeTabId: resolveActiveContextPanelTabID(nextTabs, current.activeTabId),
      isOpen: nextTabs.length > 0 ? current.isOpen : false,
      touchedAt: Date.now(),
    };
  }

  // Closing the active tab stays inside its surface: activate the most recent
  // remaining tab of the same mode, and when none remain just close the panel
  // instead of jumping to another surface.
  const activeMode = closedTabs.find((tab) => tab.id === current.activeTabId)?.mode ?? null;
  const sameModeTabs = activeMode ? nextTabs.filter((tab) => tab.mode === activeMode) : [];
  const nextSameModeTab = sameModeTabs.length > 0
    ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
    : null;

  return {
    ...current,
    tabs: nextTabs,
    activeTabId: nextSameModeTab?.id ?? resolveActiveContextPanelTabID(nextTabs, null),
    isOpen: nextSameModeTab ? current.isOpen : false,
    touchedAt: Date.now(),
  };
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

const sanitizeContextPanelByDirectory = (
  value: unknown,
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
      tabs?: unknown;
      activeTabId?: unknown;
      widthByMode?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
    };

    let tabs = sanitizeContextPanelTabs(candidate.tabs);
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

    // Legacy single-tab state can name a saved project plan, but it carries
    // no owner and cannot be migrated into an openable saved-plan tab — that
    // combination is dropped by sanitize above. A generic filesystem plan tab
    // (no plan id) revives fine from the descriptor alone.
    if (tabs.length === 0 && (candidate.mode === 'diff' || candidate.mode === 'file' || candidate.mode === 'context' || candidate.mode === 'plan' || candidate.mode === 'chat')) {
      tabs = [createContextPanelTab({
        mode: candidate.mode,
        targetPath: typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
        dedupeKey: typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
        label: typeof candidate.label === 'string' ? candidate.label : null,
      })];
      activeTabId = tabs[0]?.id ?? null;
    }

    const resolvedActiveTabId = resolveActiveContextPanelTabID(tabs, activeTabId);
    const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, resolvedActiveTabId);

    // Legacy single `width` values are intentionally dropped: widths are now
    // per-surface, seeded from registry defaults until the user resizes.
    const widthByMode: Partial<Record<ContextPanelMode, number>> = {};
    if (candidate.widthByMode && typeof candidate.widthByMode === 'object') {
      for (const [mode, value] of Object.entries(candidate.widthByMode as Record<string, unknown>)) {
        if (
          (mode === 'diff' || mode === 'file' || mode === 'context' || mode === 'plan' || mode === 'chat' || mode === 'browser' || mode === 'git' || mode === 'pr' || mode === 'linear' || mode === 'notes' || mode === 'terminal')
          && typeof value === 'number'
          && Number.isFinite(value)
        ) {
          widthByMode[mode] = clampContextPanelWidth(value);
        }
      }
    }

    next[directory] = {
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId),
      widthByMode,
      touchedAt: typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
        ? candidate.touchedAt
        : Date.now(),
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
  isMultiRunLauncherOpen: boolean;
  multiRunLauncherPrefillPrompt: string;
  isSidebarOpen: boolean;
  sidebarWidth: number;
  hasManuallyResizedLeftSidebar: boolean;
  contextPanelByDirectory: Record<string, ContextPanelDirectoryState>;
  contextRailOrder: string[];
  /** Surface ids the user hid from the context rail; stored as the hidden set
      so surfaces added later appear for everyone. */
  contextRailHiddenSurfaces: string[];
  contextEditorTreeVisible: boolean;
  contextEditorTreeWidth: number;
  notesPanelHeight: number;
  /** Expanded collapsible sections of the in-chat work-status panel, by id. */
  workStatusExpandedSections: Record<string, boolean>;
  /** Scroll offset of that panel, so it survives being unmounted. */
  workStatusScrollTop: number;
  /** Whether the in-chat work-status panel may render at all. */
  workStatusPanelEnabled: boolean;
  /**
   * Whether it is actually on screen right now — the switch can be on while
   * layout still refuses it (narrow chat, open context panel). Transient, never
   * persisted: it describes the current frame, not a preference. The header
   * reads it to stop repeating what the panel already shows.
   */
  workStatusPanelVisible: boolean;
  /** Layout can host the panel inline. Transient, like the one above. */
  workStatusPanelFits: boolean;
  /**
   * Shown over the chat because it does not fit beside it. Transient and never
   * persisted: it is a response to the current window, not a preference, and
   * the panel returns to its place as soon as there is room.
   */
  workStatusOverlayOpen: boolean;
  /**
   * Sections the user switched off. Hidden rather than visible ones are
   * stored, so a section added later appears without touching saved settings.
   * Persisted to server settings, not just this browser.
   */
  workStatusHiddenSections: string[];
  isSessionSwitcherOpen: boolean;
  isSessionDropdownOpen: boolean;
  pendingDiffFile: string | null;
  pendingDiffStaged: boolean;
  pendingDiffScope: PendingDiffScope | null;
  pendingFileNavigation: PendingFileNavigation | null;
  pendingFileFocusPath: string | null;
  isMobile: boolean;
  isCommandPaletteOpen: boolean;
  isHelpDialogOpen: boolean;
  isAboutDialogOpen: boolean;
  isOpenCodeStatusDialogOpen: boolean;
  openCodeStatusText: string;
  isSessionCreateDialogOpen: boolean;
  isScheduledTasksDialogOpen: boolean;
  isArchivePageOpen: boolean;
  worktreesPageProjectId: string | null;
  isSettingsDialogOpen: boolean;
  isNewWorktreeDialogOpen: boolean;
  isModelSelectorOpen: boolean;
  sidebarSection: SidebarSection;

  // Settings IA (new shell)
  settingsPage: string;
  settingsHasOpenedOnce: boolean;
  settingsProjectsSelectedId: string | null;
  /**
   * Project the Settings pages are looking at. `null` follows the app's active
   * project. Settings browses another project's configuration without moving
   * the chat, the session list or the file tree, so this is its own state and
   * not a second writer of the active project.
   */
  settingsProjectPath: string | null;
  settingsRemoteInstancesSelectedId: string | null;
  eventStreamStatus: EventStreamStatus;
  eventStreamHint: string | null;
  showReasoningTraces: boolean;
  streamingAutoFollowEnabled: boolean;
  sessionRecapEnabled: boolean;
  sessionSuggestionEnabled: boolean;
  sessionGoalEnabled: boolean;
  sessionGoalDefaultBudgetEnabled: boolean;
  sessionGoalDefaultBudget: number;
  collapsibleThinkingBlocks: boolean;
  chatRenderMode: ChatRenderMode;
  activityRenderMode: ActivityRenderMode;
  showDeletionDialog: boolean;
  /** When true, confirm before applying deferred OpenCode restart from Settings. */
  showOpenCodeRestartConfirm: boolean;
  autoDeleteEnabled: boolean;
  /** Global file-editor autosave. Default true for backward compatibility. */
  autoSaveEnabled: boolean;
  autoDeleteAfterDays: number;
  sessionRetentionAction: SessionRetentionAction;
  autoDeleteLastRunAt: number | null;
  messageLimit: number;
  fontSize: number;
  // Global draft welcome starters; null = unset (use the default built-in set).
  globalDraftStarters: DraftStarterRef[] | null;
  draftStartersVisible: boolean;
  terminalFontSize: number;
  terminalShell: TerminalShell;
  terminalLoginShells: TerminalShell[];
  editorFontSize: number;
  uiFont: UiFontOption;
  monoFont: MonoFontOption;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;
  mobileKeyboardMode: MobileKeyboardMode;

  favoriteModels: Array<{ providerID: string; modelID: string }>;
  hiddenModels: Array<{ providerID: string; modelID: string }>;
  providerOrder: string[];
  collapsedModelProviders: string[];
  recentModels: Array<{ providerID: string; modelID: string }>;
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;

  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
  diffWrapLines: boolean;
  /** Width of the walkthrough table of contents, in pixels. */
  walkthroughTocWidth: number;
  gitChangesViewMode: 'flat' | 'tree';
  linearIssueListStatus: LinearIssueListStatus;
  linearIssueListAssignee: LinearIssueListAssignee;
  linearIssueListTeamId: string;
  linearIssueListPriority: LinearIssueListPriority;
  /** One-shot identifier for opening a Linear issue in the rail panel. Not persisted. */
  linearIssueFocus: string | null;
  isTimelineDialogOpen: boolean;
  isPromptNavigatorPanelOpen: boolean;
  isImagePreviewOpen: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnSubtasks: boolean;
  // Desktop dock badge showing the count of sessions with unseen activity (macOS).
  dockBadgeEnabled: boolean;

  // Event toggles (which events trigger notifications)
  notifyOnCompletion: boolean;
  notifyOnError: boolean;
  notifyOnQuestion: boolean;

  // Per-event notification templates
  notificationTemplates: {
    completion: { title: string; message: string };
    error: { title: string; message: string };
    question: { title: string; message: string };
    subtask: { title: string; message: string };
  };

  // Summarization settings
  summarizeLastMessage: boolean;
  summaryThreshold: number;   // chars — messages longer than this get summarized
  summaryLength: number;      // chars — target length for summary
  maxLastMessageLength: number; // chars — truncate {last_message} when summarization is off

  showTerminalQuickKeysOnDesktop: boolean;
  /** Header session tabs (web/desktop), opt-in. Off keeps the plain session title. */
  sessionTabsEnabled: boolean;
  persistChatDraft: boolean;
  showOpenCodeUpdateNotifications: boolean;
  agentControlToolEnabled: boolean;
  agentWebToolEnabled: boolean;
  agentMemoryToolEnabled: boolean;
  /**
   * Whether this build has agent memory at all. Server-owned and not
   * persisted: an unreleased feature must not come back from a stale cache.
   */
  agentMemoryFeatureAvailable: boolean;
  /**
   * When the user last looked at each memory scope, keyed by scope. Drives the
   * new/changed badges; there is no stored review state.
   */
  agentMemoryViewedAt: Record<string, number>;
  /** Width of the project context panel's section sidebar, in pixels. */
  projectContextSidebarWidth: number;
  /** Active tab of the project context panel (notes/todos/plans). */
  projectContextTab: string;
  inputSpellcheckEnabled: boolean;
  largeTextPasteBehavior: LargeTextPasteBehavior;
  wideChatLayoutEnabled: boolean;
  codeBlockLineWrap: boolean;
  showToolFileIcons: boolean;
  showTurnChangedFiles: boolean;
  showExpandedBashTools: boolean;
  showExpandedEditTools: boolean;
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
  isExpandedInput: boolean;
  reportUsage: boolean;
  shortcutOverrides: Record<string, ShortcutCombo>;
  fileEditorKeymap: FileEditorKeymap;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setContextRailOrder: (order: string[]) => void;
  toggleContextEditorTree: () => void;
  setContextEditorTreeWidth: (width: number) => void;
  openContextSurface: (directory: string, mode: ContextPanelMode) => void;
  openContextPanelTab: (directory: string, tab: ContextPanelTabDescriptor, options?: { reveal?: boolean }) => void;
  openContextDiff: (directory: string, filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  openContextFile: (directory: string, filePath: string) => void;
  openContextFileAtLine: (directory: string, filePath: string, line: number, column?: number) => void;
  openContextOverview: (directory: string) => void;
  openContextPreview: (directory: string, url: string) => void;
  openContextBrowser: (directory: string, url?: string, options?: { reveal?: boolean }) => void;
  openNewContextBrowserTab: (directory: string) => void;
  setContextPanelTabTargetPath: (directory: string, tabID: string, targetPath: string) => void;
  setActiveContextPanelTab: (directory: string, tabID: string) => void;
  reorderContextPanelTabs: (directory: string, activeTabID: string, overTabID: string) => void;
  closeContextPanelTab: (directory: string, tabID: string) => void;
  closeContextPanelTabs: (directory: string, tabIds: readonly string[]) => void;
  closeContextPanel: (directory: string) => void;
  toggleContextPanelExpanded: (directory: string) => void;
  setContextPanelWidth: (directory: string, mode: ContextPanelMode, width: number) => void;
  setNotesPanelHeight: (height: number) => void;
  setWorkStatusSectionExpanded: (sectionId: string, expanded: boolean) => void;
  setWorkStatusScrollTop: (scrollTop: number) => void;
  setWorkStatusPanelEnabled: (enabled: boolean) => void;
  setWorkStatusPanelVisible: (visible: boolean) => void;
  setWorkStatusPanelFits: (fits: boolean) => void;
  setWorkStatusOverlayOpen: (open: boolean) => void;
  setWorkStatusSectionVisible: (sectionId: string, visible: boolean) => void;
  setWorkStatusHiddenSections: (sectionIds: string[]) => void;
  setContextRailSurfaceVisible: (surfaceId: string, visible: boolean) => void;
  setContextRailHiddenSurfaces: (surfaceIds: string[]) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setSessionDropdownOpen: (open: boolean) => void;
  setPendingDiffFile: (filePath: string | null, staged?: boolean, scope?: PendingDiffScope | null) => void;
  setPendingFileNavigation: (navigation: PendingFileNavigation | null) => void;
  setPendingFileFocusPath: (path: string | null) => void;
  navigateToDiff: (filePath: string, staged?: boolean, scope?: PendingDiffScope | null) => void;
  consumePendingDiffFile: () => string | null;
  setIsMobile: (isMobile: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleHelpDialog: () => void;
  setHelpDialogOpen: (open: boolean) => void;
  setAboutDialogOpen: (open: boolean) => void;
  setOpenCodeStatusDialogOpen: (open: boolean) => void;
  setOpenCodeStatusText: (text: string) => void;
  setSessionCreateDialogOpen: (open: boolean) => void;
  setScheduledTasksDialogOpen: (open: boolean) => void;
  setArchivePageOpen: (open: boolean) => void;
  setWorktreesPageProjectId: (projectId: string | null) => void;
  /** Close every full-page surface (Scheduled, Archive, Worktrees, Multi-run). */
  closeMainSurfaces: () => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setNewWorktreeDialogOpen: (open: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
  applyTheme: () => void;
  setSidebarSection: (section: SidebarSection) => void;
  setSettingsPage: (slug: string) => void;
  setSettingsProjectsSelectedId: (projectId: string | null) => void;
  setSettingsProjectPath: (path: string | null) => void;
  setSettingsRemoteInstancesSelectedId: (instanceId: string | null) => void;
  setEventStreamStatus: (status: EventStreamStatus, hint?: string | null) => void;
  setShowReasoningTraces: (value: boolean) => void;
  setStreamingAutoFollowEnabled: (value: boolean) => void;
  setSessionRecapEnabled: (value: boolean) => void;
  setSessionSuggestionEnabled: (value: boolean) => void;
  setSessionGoalEnabled: (value: boolean) => void;
  setSessionGoalDefaultBudgetEnabled: (value: boolean) => void;
  setSessionGoalDefaultBudget: (value: number) => void;
  setCollapsibleThinkingBlocks: (value: boolean) => void;
  setChatRenderMode: (value: ChatRenderMode) => void;
  setActivityRenderMode: (value: ActivityRenderMode) => void;
  setShowDeletionDialog: (value: boolean) => void;
  setShowOpenCodeRestartConfirm: (value: boolean) => void;
  setAutoDeleteEnabled: (value: boolean) => void;
  setAutoSaveEnabled: (value: boolean) => void;
  setAutoDeleteAfterDays: (days: number) => void;
  setSessionRetentionAction: (value: SessionRetentionAction) => void;
  setAutoDeleteLastRunAt: (timestamp: number | null) => void;
  setMessageLimit: (value: number) => void;
  setFontSize: (size: number) => void;
  setGlobalDraftStarters: (refs: DraftStarterRef[]) => void;
  setDraftStartersVisible: (value: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  setTerminalLoginShells: (shells: TerminalShell[]) => void;
  setEditorFontSize: (size: number) => void;
  setUiFont: (font: UiFontOption) => void;
  setMonoFont: (font: MonoFontOption) => void;
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
  toggleHiddenModel: (providerID: string, modelID: string) => void;
  isHiddenModel: (providerID: string, modelID: string) => boolean;
  hideAllModels: (providerID: string, modelIDs: string[]) => void;
  showAllModels: (providerID: string) => void;
  toggleModelProviderCollapsed: (providerID: string) => void;
  setModelProvidersCollapsed: (providerIDs: string[], collapsed: boolean) => void;
  isFavoriteModel: (providerID: string, modelID: string) => boolean;
  addRecentModel: (providerID: string, modelID: string) => void;
  addRecentAgent: (agentName: string) => void;
  addRecentEffort: (providerID: string, modelID: string, variant: string | undefined) => void;
  setDiffLayoutPreference: (mode: 'dynamic' | 'inline' | 'side-by-side') => void;
  setDiffFileLayout: (filePath: string, mode: 'inline' | 'side-by-side') => void;
  setDiffWrapLines: (wrap: boolean) => void;
  setWalkthroughTocWidth: (width: number) => void;
  setGitChangesViewMode: (mode: 'flat' | 'tree') => void;
  setLinearIssueListStatus: (status: LinearIssueListStatus) => void;
  setLinearIssueListAssignee: (assignee: LinearIssueListAssignee) => void;
  setLinearIssueListTeamId: (teamId: string) => void;
  setLinearIssueListPriority: (priority: LinearIssueListPriority) => void;
  resetLinearIssueListFilters: () => void;
  setLinearIssueFocus: (identifier: string | null) => void;
  setMultiRunLauncherOpen: (open: boolean) => void;
  setTimelineDialogOpen: (open: boolean) => void;
  setPromptNavigatorPanelOpen: (open: boolean) => void;
  togglePromptNavigatorPanel: () => void;
  setImagePreviewOpen: (open: boolean) => void;
  setNativeNotificationsEnabled: (value: boolean) => void;
  setNotificationMode: (mode: 'always' | 'hidden-only') => void;
  setShowTerminalQuickKeysOnDesktop: (value: boolean) => void;
  setSessionTabsEnabled: (value: boolean) => void;
  setNotifyOnSubtasks: (value: boolean) => void;
  setDockBadgeEnabled: (value: boolean) => void;
  setNotifyOnCompletion: (value: boolean) => void;
  setNotifyOnError: (value: boolean) => void;
  setNotifyOnQuestion: (value: boolean) => void;
  setNotificationTemplates: (
    templates: UIStore['notificationTemplates'] | ((current: UIStore['notificationTemplates']) => UIStore['notificationTemplates']),
  ) => void;
  setSummarizeLastMessage: (value: boolean) => void;
  setSummaryThreshold: (value: number) => void;
  setSummaryLength: (value: number) => void;
  setMaxLastMessageLength: (value: number) => void;
  setPersistChatDraft: (value: boolean) => void;
  setShowOpenCodeUpdateNotifications: (value: boolean) => void;
  setAgentControlToolEnabled: (value: boolean) => void;
  setAgentWebToolEnabled: (value: boolean) => void;
  setAgentMemoryToolEnabled: (value: boolean) => void;
  setAgentMemoryFeatureAvailable: (value: boolean) => void;
  markAgentMemoryViewed: (key: string, viewedAt: number) => void;
  setProjectContextSidebarWidth: (width: number) => void;
  setProjectContextTab: (value: string) => void;
  setInputSpellcheckEnabled: (value: boolean) => void;
  setLargeTextPasteBehavior: (value: LargeTextPasteBehavior) => void;
  setWideChatLayoutEnabled: (value: boolean) => void;
  setCodeBlockLineWrap: (value: boolean) => void;
  setShowToolFileIcons: (value: boolean) => void;
  setShowTurnChangedFiles: (value: boolean) => void;
  setShowExpandedBashTools: (value: boolean) => void;
  setShowExpandedEditTools: (value: boolean) => void;
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
  viewPagerPage: 'left' | 'center' | 'right';
  setViewPagerPage: (page: 'left' | 'center' | 'right') => void;
  toggleExpandedInput: () => void;
  setExpandedInput: (value: boolean) => void;
  openMultiRunLauncher: () => void;
  openMultiRunLauncherWithPrompt: (prompt: string) => void;
  setReportUsage: (value: boolean) => void;
  setShortcutOverride: (actionId: string, combo: ShortcutCombo) => void;
  clearShortcutOverride: (actionId: string) => void;
  resetAllShortcutOverrides: () => void;
  setFileEditorKeymap: (value: FileEditorKeymap) => void;
}


export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set, get) => ({

        theme: 'system',
        isMultiRunLauncherOpen: false,
        multiRunLauncherPrefillPrompt: '',
        isSidebarOpen: true,
        sidebarWidth: LEFT_SIDEBAR_MIN_WIDTH,
        hasManuallyResizedLeftSidebar: false,
        contextPanelByDirectory: {},
        contextRailOrder: [],
        contextRailHiddenSurfaces: [],
        contextEditorTreeVisible: true,
        contextEditorTreeWidth: 240,
        notesPanelHeight: 112,
        workStatusExpandedSections: {},
        workStatusScrollTop: 0,
        workStatusPanelEnabled: true,
        workStatusPanelVisible: false,
        workStatusPanelFits: false,
        workStatusOverlayOpen: false,
        workStatusHiddenSections: [],
        isSessionSwitcherOpen: false,
        isSessionDropdownOpen: false,
        pendingDiffFile: null,
        pendingDiffStaged: false,
        pendingDiffScope: null,
        pendingFileNavigation: null,
        pendingFileFocusPath: null,
        isMobile: false,
        isCommandPaletteOpen: false,
        isHelpDialogOpen: false,
        isAboutDialogOpen: false,
        isOpenCodeStatusDialogOpen: false,
        openCodeStatusText: '',
        isSessionCreateDialogOpen: false,
        isScheduledTasksDialogOpen: false,
        isArchivePageOpen: false,
        worktreesPageProjectId: null,
        isSettingsDialogOpen: false,
        isNewWorktreeDialogOpen: false,
        isModelSelectorOpen: false,
        sidebarSection: 'sessions',
        settingsPage: 'home',
        settingsHasOpenedOnce: false,
        settingsProjectsSelectedId: null,
        settingsProjectPath: null,
        settingsRemoteInstancesSelectedId: null,
        eventStreamStatus: 'idle',
        eventStreamHint: null,
        showReasoningTraces: true,
        streamingAutoFollowEnabled: true,
        sessionRecapEnabled: true,
        sessionSuggestionEnabled: true,
        sessionGoalEnabled: true,
        sessionGoalDefaultBudgetEnabled: false,
        sessionGoalDefaultBudget: 200_000,
        collapsibleThinkingBlocks: true,
        chatRenderMode: 'live',
        activityRenderMode: 'summary',
        showDeletionDialog: true,
        showOpenCodeRestartConfirm: true,
        autoDeleteEnabled: false,
        autoSaveEnabled: true,
        autoDeleteAfterDays: 30,
        sessionRetentionAction: 'archive',
        autoDeleteLastRunAt: null,
        messageLimit: 200,
        fontSize: 100,
        globalDraftStarters: null,
        terminalFontSize: 14,
        terminalShell: 'auto',
        terminalLoginShells: [],
        editorFontSize: 13,
        uiFont: DEFAULT_UI_FONT,
        monoFont: DEFAULT_MONO_FONT,
        padding: 100,
        cornerRadius: 18,
        inputBarOffset: 0,
        mobileKeyboardMode: getStoredMobileKeyboardMode(),
        favoriteModels: [],
        hiddenModels: [],
        providerOrder: [],
        collapsedModelProviders: [],
        recentModels: [],
        recentAgents: [],
        recentEfforts: {},
        diffLayoutPreference: 'inline',
        diffFileLayout: {},
        diffWrapLines: false,
        walkthroughTocWidth: 224,
        gitChangesViewMode: 'flat',
        linearIssueListStatus: 'all',
        linearIssueListAssignee: 'any',
        linearIssueListTeamId: LINEAR_ISSUE_LIST_ALL_TEAMS,
        linearIssueListPriority: 'all',
        linearIssueFocus: null,
        isTimelineDialogOpen: false,
        isPromptNavigatorPanelOpen: false,
        isImagePreviewOpen: false,
        nativeNotificationsEnabled: false,
        notificationMode: 'hidden-only',
        notifyOnSubtasks: true,
        dockBadgeEnabled: true,

        // Event toggles (which events trigger notifications)
        notifyOnCompletion: true,
        notifyOnError: true,
        notifyOnQuestion: true,
        notificationTemplates: {
          completion: { ...EMPTY_NOTIFICATION_TEMPLATES.completion },
          error: { ...EMPTY_NOTIFICATION_TEMPLATES.error },
          question: { ...EMPTY_NOTIFICATION_TEMPLATES.question },
          subtask: { ...EMPTY_NOTIFICATION_TEMPLATES.subtask },
        },

        // Summarization settings
        summarizeLastMessage: false,
        summaryThreshold: 200,
        summaryLength: 100,
        maxLastMessageLength: 250,

        showTerminalQuickKeysOnDesktop: false,
        sessionTabsEnabled: false,
        persistChatDraft: true,
        showOpenCodeUpdateNotifications: !isWindowsArm64(),
        agentControlToolEnabled: true,
        agentWebToolEnabled: true,
        agentMemoryToolEnabled: false,
        agentMemoryFeatureAvailable: false,
        agentMemoryViewedAt: {},
        projectContextSidebarWidth: 168,
        projectContextTab: 'notes',
        inputSpellcheckEnabled: false,
        largeTextPasteBehavior: DEFAULT_LARGE_TEXT_PASTE_BEHAVIOR,
        wideChatLayoutEnabled: false,
        codeBlockLineWrap: true,
        showToolFileIcons: true,
        showTurnChangedFiles: false,
        showExpandedBashTools: false,
        showExpandedEditTools: false,
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
        draftStartersVisible: true,
        isExpandedInput: false,
        reportUsage: true,
        shortcutOverrides: {},
        fileEditorKeymap: 'default',

        setTheme: (theme) => {
          set({ theme });
          get().applyTheme();
        },

        toggleSidebar: () => {
          set((state) => {
            const newOpen = !state.isSidebarOpen;

            if (newOpen && !state.hasManuallyResizedLeftSidebar) {
              return {
                isSidebarOpen: newOpen,
                sidebarWidth: LEFT_SIDEBAR_MIN_WIDTH,
              };
            }
            return { isSidebarOpen: newOpen };
          });
        },

        setSidebarOpen: (open) => {
          set((state) => {
            if (state.isSidebarOpen === open) {
              if (!open) {
                return state;
              }
              if (!state.hasManuallyResizedLeftSidebar && state.sidebarWidth !== LEFT_SIDEBAR_MIN_WIDTH) {
                return {
                  isSidebarOpen: open,
                  sidebarWidth: LEFT_SIDEBAR_MIN_WIDTH,
                };
              }
              return state;
            }
            if (open && !state.hasManuallyResizedLeftSidebar) {
              return {
                isSidebarOpen: open,
                sidebarWidth: LEFT_SIDEBAR_MIN_WIDTH,
              };
            }
            return { isSidebarOpen: open };
          });
        },

        setSidebarWidth: (width) => {
          set({ sidebarWidth: width, hasManuallyResizedLeftSidebar: true });
        },

        setContextRailOrder: (order) => {
          const sanitized = Array.isArray(order)
            ? order.filter((id, index) => typeof id === 'string' && id.trim() !== '' && order.indexOf(id) === index)
            : [];
          set({ contextRailOrder: sanitized });
        },

        toggleContextEditorTree: () => {
          set((state) => ({ contextEditorTreeVisible: !state.contextEditorTreeVisible }));
        },

        setContextEditorTreeWidth: (width) => {
          if (!Number.isFinite(width)) {
            return;
          }
          set({ contextEditorTreeWidth: Math.min(480, Math.max(200, Math.round(width))) });
        },

        // Rail entry point: activates the most recent tab of the requested
        // mode, opens a fresh singleton tab when none exists, and toggles the
        // panel closed when the requested mode is already active and visible.
        openContextSurface: (directory, mode) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          const state = get();
          const panelState = state.contextPanelByDirectory[normalizedDirectory];
          const tabs = panelState?.tabs ?? [];
          const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;

          if (panelState?.isOpen && activeTab?.mode === mode) {
            state.closeContextPanel(normalizedDirectory);
            return;
          }

          const tabsOfMode = tabs.filter((tab) => tab.mode === mode);
          if (tabsOfMode.length > 0) {
            // `>=` so equal timestamps (same-millisecond opens) resolve to the
            // later tab in insertion order.
            const mostRecent = tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
            state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
            return;
          }

          // Content-driven modes need a payload (a session to split); the rail
          // renders them disabled until content exists. 'file' opens an empty
          // editor whose embedded tree picks the first file.
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

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: upsertContextPanelTab(current, tab, options),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
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

        openContextFile: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'file', targetPath: normalizedFilePath });
          get().setPendingFileFocusPath(normalizedFilePath);
          get().setPendingFileNavigation(null);
        },

        openContextFileAtLine: (directory, filePath, line, column) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = normalizeContextTargetPath(filePath);
          const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
          const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'file', targetPath: normalizedFilePath });
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

          // No stored label: a browser tab is named after wherever it has
          // navigated to, which the panel derives from targetPath.
          get().openContextPanelTab(normalizedDirectory, {
            mode: 'browser',
            targetPath: normalizedUrl,
            dedupeKey: normalizedUrl,
            label: null,
          });
        },
        // Always a new tab, never the existing one: the whole point of asking
        // for one is to keep what is already open.
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

        setActiveContextPanelTab: (directory, tabID) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabID = (tabID || '').trim();
          if (!normalizedDirectory || !normalizedTabID) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            if (!current.tabs.some((tab) => tab.id === normalizedTabID)) {
              return state;
            }

            if (current.activeTabId === normalizedTabID && current.isOpen) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                isOpen: true,
                activeTabId: normalizedTabID,
                touchedAt: Date.now(),
                tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
                  ? { ...tab, touchedAt: Date.now() }
                  : tab)),
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
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
            const current = touchContextPanelState(prev);
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

        closeContextPanelTab: (directory, tabID) => {
          get().closeContextPanelTabs(directory, [tabID]);
        },

        closeContextPanelTabs: (directory, tabIds) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedTabIds = (tabIds ?? [])
            .map((id) => (id || '').trim())
            .filter((id) => id.length > 0);
          if (!normalizedDirectory || normalizedTabIds.length === 0) {
            return;
          }

          const closedTabs = normalizedTabIds
            .map((id) => get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === id))
            .filter((tab): tab is ContextPanelTab => Boolean(tab));

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            if (!current.tabs.some((tab) => normalizedTabIds.includes(tab.id))) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: closeContextPanelTabs(current, normalizedTabIds),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });

          // Keep the editor's own open-file state in sync so closed files do not
          // resurrect when the editor surface reopens.
          for (const tab of closedTabs) {
            if (tab.mode === 'file' && tab.targetPath) {
              useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, tab.targetPath);
            }
          }
        },

        closeContextPanel: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            if (!prev || !prev.isOpen) {
              return state;
            }

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...touchContextPanelState(prev),
                isOpen: false,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        toggleContextPanelExpanded: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                expanded: !current.expanded,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        setContextPanelWidth: (directory, mode, width) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                widthByMode: {
                  ...current.widthByMode,
                  [mode]: clampContextPanelWidth(width),
                },
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        setNotesPanelHeight: (height) => {
          set({ notesPanelHeight: height });
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
            // Room again: the panel goes back to its place, so an overlay left
            // open would duplicate it.
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
              workStatusHiddenSections: visible
                ? hidden.filter((entry) => entry !== sectionId)
                : [...hidden, sectionId],
            };
          });
        },

        setWorkStatusHiddenSections: (sectionIds) => {
          set({ workStatusHiddenSections: [...new Set(sectionIds)] });
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
            ? { isScheduledTasksDialogOpen: true, isArchivePageOpen: false, worktreesPageProjectId: null, isMultiRunLauncherOpen: false }
            : { isScheduledTasksDialogOpen: false });
        },

        setArchivePageOpen: (open) => {
          set(open
            ? { isArchivePageOpen: true, isScheduledTasksDialogOpen: false, worktreesPageProjectId: null, isMultiRunLauncherOpen: false }
            : { isArchivePageOpen: false });
        },

        setWorktreesPageProjectId: (projectId) => {
          set(projectId
            ? { worktreesPageProjectId: projectId, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isMultiRunLauncherOpen: false }
            : { worktreesPageProjectId: null });
        },

        closeMainSurfaces: () => {
          const state = get();
          if (!state.isScheduledTasksDialogOpen && !state.isArchivePageOpen && !state.worktreesPageProjectId && !state.isMultiRunLauncherOpen) {
            return;
          }
          set({
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
            isMultiRunLauncherOpen: false,
            multiRunLauncherPrefillPrompt: '',
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

        setSessionGoalEnabled: (value) => {
          set({ sessionGoalEnabled: value });
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

        setChatRenderMode: (value) => {
          set({ chatRenderMode: value });
        },

        setActivityRenderMode: (value) => {
          set({ activityRenderMode: value });
        },

        setShowDeletionDialog: (value) => {
          set({ showDeletionDialog: value });
        },

        setShowOpenCodeRestartConfirm: (value) => {
          set({ showOpenCodeRestartConfirm: value });
        },

        setAutoDeleteEnabled: (value) => {
          set({ autoDeleteEnabled: value });
        },

        setAutoSaveEnabled: (value) => {
          set({ autoSaveEnabled: value });
        },

        setAutoDeleteAfterDays: (days) => {
          const clampedDays = Math.max(1, Math.min(365, days));
          set({ autoDeleteAfterDays: clampedDays });
        },

        setSessionRetentionAction: (value) => {
          set({ sessionRetentionAction: value });
        },

        setAutoDeleteLastRunAt: (timestamp) => {
          set({ autoDeleteLastRunAt: timestamp });
        },

        setMessageLimit: (value) => {
          const clamped = Math.max(10, Math.min(500, Math.round(value)));
          set({ messageLimit: clamped });
        },

        setFontSize: (size) => {
          // Clamp between 50% and 200%
          const clampedSize = Math.max(50, Math.min(200, size));
          set({ fontSize: clampedSize });
          get().applyTypography();
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

        setPadding: (size) => {
          // Clamp between 50% and 200%
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

          // 100 = default (1.0x), 50 = half size (0.5x), 200 = double (2.0x)
          const scale = fontSize / 100;

          const entries = Object.entries(SEMANTIC_TYPOGRAPHY) as Array<[SemanticTypographyKey, string]>;

          // Default must be SEMANTIC_TYPOGRAPHY (from CSS). Remove overrides.
          if (scale === 1) {
            for (const [key] of entries) {
              root.style.removeProperty(getTypographyVariable(key));
            }
            return;
          }

          for (const [key, baseValue] of entries) {
            const numericValue = parseFloat(baseValue);
            if (!Number.isFinite(numericValue)) {
              continue;
            }
            root.style.setProperty(getTypographyVariable(key), `${numericValue * scale}rem`);
          }
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

          // Apply padding as a percentage scale with non-linear scaling
          // Use square root for more natural scaling at extremes
          const adjustedScale = Math.sqrt(scale);

          // Set the CSS custom property that all spacing tokens reference
          root.style.setProperty('--padding-scale', adjustedScale.toString());

          // Dampened line-height scaling at extremes
          const lineHeightScale = 1 + (scale - 1) * 0.15;

          root.style.setProperty('--line-height-tight', (1.25 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-normal', (1.5 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-relaxed', (1.625 * lineHeightScale).toFixed(3));
          root.style.setProperty('--line-height-loose', (2 * lineHeightScale).toFixed(3));
        },

        setDiffLayoutPreference: (mode) => {
          set({ diffLayoutPreference: mode });
        },

        setDiffFileLayout: (filePath, mode) => {
          set((state) => ({
            diffFileLayout: {
              ...state.diffFileLayout,
              [filePath]: mode,
            },
          }));
        },

        setDiffWrapLines: (wrap) => {
          set({ diffWrapLines: wrap });
        },

        setWalkthroughTocWidth: (width) => {
          set({ walkthroughTocWidth: Math.round(width) });
        },

        setGitChangesViewMode: (mode) => {
          set({ gitChangesViewMode: mode });
        },

        setLinearIssueListStatus: (status) => {
          set({ linearIssueListStatus: sanitizeLinearIssueListStatus(status) });
        },

        setLinearIssueListAssignee: (assignee) => {
          set({ linearIssueListAssignee: sanitizeLinearIssueListAssignee(assignee) });
        },

        setLinearIssueListTeamId: (teamId) => {
          set({ linearIssueListTeamId: sanitizeLinearIssueListTeamId(teamId) });
        },

        setLinearIssueListPriority: (priority) => {
          set({ linearIssueListPriority: sanitizeLinearIssueListPriority(priority) });
        },

        resetLinearIssueListFilters: () => {
          set({
            linearIssueListStatus: 'all',
            linearIssueListAssignee: 'any',
            linearIssueListTeamId: LINEAR_ISSUE_LIST_ALL_TEAMS,
            linearIssueListPriority: 'all',
          });
        },

        setLinearIssueFocus: (identifier) => {
          const trimmed = identifier?.trim() ?? '';
          set({ linearIssueFocus: trimmed || null });
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
              // Remove from favorites
              return {
                favoriteModels: state.favoriteModels.filter(
                  (fav) => !(fav.providerID === providerID && fav.modelID === modelID)
                ),
              };
            } else {
              // Add to favorites (newest first)
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
            // Remove existing instance if any
            const filtered = state.recentModels.filter(
              (m) => !(m.providerID === providerID && m.modelID === modelID)
            );
            // Add to front, limit to 5
            return {
              recentModels: [{ providerID, modelID }, ...filtered].slice(0, 5),
            };
          });
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
          const provider = typeof providerID === 'string' ? providerID.trim() : '';
          const model = typeof modelID === 'string' ? modelID.trim() : '';
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

        // Multi-run is one of the mutually exclusive full-page surfaces:
        // opening it closes the other surfaces and vice versa.
        setMultiRunLauncherOpen: (open) => {
          set((state) => ({
            isMultiRunLauncherOpen: open,
            multiRunLauncherPrefillPrompt: open ? state.multiRunLauncherPrefillPrompt : '',
            ...(open ? { isScheduledTasksDialogOpen: false, isArchivePageOpen: false, worktreesPageProjectId: null } : {}),
          }));
        },

        openMultiRunLauncher: () => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: '',
            isSessionSwitcherOpen: false,
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
          });
        },

        openMultiRunLauncherWithPrompt: (prompt) => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: prompt,
            isSessionSwitcherOpen: false,
            isScheduledTasksDialogOpen: false,
            isArchivePageOpen: false,
            worktreesPageProjectId: null,
          });
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

        setNotifyOnSubtasks: (value) => {
          set({ notifyOnSubtasks: value });
        },

        setDockBadgeEnabled: (value) => {
          set({ dockBadgeEnabled: value });
        },

        setNotifyOnCompletion: (value) => { set({ notifyOnCompletion: value }); },
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
        setPersistChatDraft: (value) => {
          set({ persistChatDraft: value });
        },
        setShowOpenCodeUpdateNotifications: (value) => {
          set({ showOpenCodeUpdateNotifications: value });
        },
        setAgentControlToolEnabled: (value) => {
          set({ agentControlToolEnabled: value });
        },
        setAgentWebToolEnabled: (value) => {
          set({ agentWebToolEnabled: value });
        },
        setAgentMemoryToolEnabled: (value) => {
          set({ agentMemoryToolEnabled: value });
        },
        setAgentMemoryFeatureAvailable: (value) => {
          set({ agentMemoryFeatureAvailable: value });
        },
        setProjectContextSidebarWidth: (width) => {
          set({ projectContextSidebarWidth: width });
        },
        markAgentMemoryViewed: (key, viewedAt) => {
          set((state) => ({
            // Never moves backwards: a stale unmount landing after a newer look
            // would otherwise resurrect badges the user has already cleared.
            agentMemoryViewedAt: viewedAt > (state.agentMemoryViewedAt[key] ?? 0)
              ? { ...state.agentMemoryViewedAt, [key]: viewedAt }
              : state.agentMemoryViewedAt,
          }));
        },
        setProjectContextTab: (value) => {
          set({ projectContextTab: value });
        },
        setInputSpellcheckEnabled: (value) => {
          set({ inputSpellcheckEnabled: value });
        },
        setLargeTextPasteBehavior: (value) => {
          set({ largeTextPasteBehavior: normalizeLargeTextPasteBehavior(value) });
        },
        setWideChatLayoutEnabled: (value) => {
          set({ wideChatLayoutEnabled: value });
        },
        setCodeBlockLineWrap: (value) => {
          set({ codeBlockLineWrap: value });
        },
        setShowToolFileIcons: (value) => {
          set({ showToolFileIcons: value });
        },
        setShowTurnChangedFiles: (value) => {
          set({ showTurnChangedFiles: value });
        },
        setShowExpandedBashTools: (value) => {
          set({ showExpandedBashTools: value });
        },
        setShowExpandedEditTools: (value) => {
          set({ showExpandedEditTools: value });
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
        version: 18,
        migrate: (persistedState, version) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return persistedState;
          }
          const state = persistedState as Record<string, unknown>;

          // v15 -> v16: the main-area surface concept is gone from persistence
          // (the chat always owns the desktop main area; panel surfaces have
          // their own state). Drop the historic fields so a stored non-chat
          // value cannot rehydrate into a blank main area.
          if (version < 16) {
            delete state.activeMainTab;
            delete state.activeSurface;
          }

          // v16 -> v17: the editor toolbar is always docked; the preference is gone.
          if (version < 17) {
            delete state.expandedEditorToolbar;
          }

          // v17 -> v18: the default shortcut layout was redesigned around the
          // mod+k leader and the held digit prefixes. Old overrides were
          // recorded against the previous defaults (e.g. a bare 'mod' surface
          // prefix now collides with session tabs), so custom bindings start
          // fresh on the new system.
          if (version < 18) {
            delete state.shortcutOverrides;
          }

          // v13 -> v14: the separate 'preview' surface merged into 'browser'.
          // Stored preview tabs keep their URL and become browser tabs; their
          // id encodes the mode, so it is rebuilt rather than left dangling.
          // Persisted widths recorded under 'preview' carry over only when the
          // user has not already sized the browser surface.
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
                  // A converted tab can collide with a browser tab on the same
                  // URL; keep the existing one rather than producing duplicates.
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

          // v12 -> v13: promote FilesView localStorage autosave toggle into the store.
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

          // v11 -> v12: drop legacy window-controls "auto" (always meant right).
          if (version < 12) {
            if (state.desktopWindowControlsPosition === 'auto' || state.desktopWindowControlsPosition == null) {
              state.desktopWindowControlsPosition = 'right';
            }
          }

          // v10 -> v11: move the previous terminal font default forward.
          if (version < 11 && state.terminalFontSize === 13) {
            state.terminalFontSize = 14;
          }

          // v9 -> v10: remove obsolete single-file diff view mode setting
          if (version < 10) {
            delete state.diffViewMode;
          }

          // v8 -> v9: initialize notes/todo panel height fields
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
            if (typeof state.notesPanelHeight !== 'number' || !Number.isFinite(state.notesPanelHeight)) {
              state.notesPanelHeight = 112;
            }
          }

          // v0 -> v1: reset legacy notification templates
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

          // v2 -> v3: collapse 3 memory-limit fields into single messageLimit.
          // Pick the best user-customised value (prefer historical, fall back to active).
          // Discard old defaults (90/120/180) — they become the new single default (200).
          if (version < 3) {
            const OLD_DEFAULTS = new Set([90, 120, 180, 220]);
            const hist = state.memoryLimitHistorical as number | undefined;
            const active = state.memoryLimitActiveSession as number | undefined;

            // If user had a non-default custom value, keep it as the new messageLimit.
            if (typeof hist === 'number' && !OLD_DEFAULTS.has(hist)) {
              state.messageLimit = hist;
            } else if (typeof active === 'number' && !OLD_DEFAULTS.has(active)) {
              state.messageLimit = active;
            }
            // Otherwise leave undefined → Zustand uses the initial default (200).

            delete state.memoryLimitHistorical;
            delete state.memoryLimitViewport;
            delete state.memoryLimitActiveSession;
          }

          // Right-sidebar state was removed with the sidebar itself; drop
          // stale persisted fields.
          delete state.isRightSidebarOpen;
          delete state.rightSidebarWidth;
          delete state.rightSidebarTab;

          state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory);

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

          state.linearIssueListStatus = sanitizeLinearIssueListStatus(state.linearIssueListStatus);
          state.linearIssueListAssignee = sanitizeLinearIssueListAssignee(state.linearIssueListAssignee);
          state.linearIssueListTeamId = sanitizeLinearIssueListTeamId(state.linearIssueListTeamId);
          state.linearIssueListPriority = sanitizeLinearIssueListPriority(state.linearIssueListPriority);

          state.fileEditorKeymap = normalizeFileEditorKeymap(state.fileEditorKeymap);
          state.largeTextPasteBehavior = normalizeLargeTextPasteBehavior(state.largeTextPasteBehavior);

          if (typeof state.autoSaveEnabled !== 'boolean') {
            state.autoSaveEnabled = true;
          }

          state.contextRailHiddenSurfaces = Array.isArray(state.contextRailHiddenSurfaces)
            ? (state.contextRailHiddenSurfaces as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          state.contextRailOrder = Array.isArray(state.contextRailOrder)
            ? (state.contextRailOrder as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];

          return state;
        },
        partialize: (state) => ({
          theme: state.theme,
          isSidebarOpen: state.isSidebarOpen,
          sidebarWidth: state.sidebarWidth,
          contextPanelByDirectory: state.contextPanelByDirectory,
          contextRailOrder: state.contextRailOrder,
          contextRailHiddenSurfaces: state.contextRailHiddenSurfaces,
          contextEditorTreeVisible: state.contextEditorTreeVisible,
          contextEditorTreeWidth: state.contextEditorTreeWidth,
          notesPanelHeight: state.notesPanelHeight,
          workStatusExpandedSections: state.workStatusExpandedSections,
          workStatusScrollTop: state.workStatusScrollTop,
          workStatusPanelEnabled: state.workStatusPanelEnabled,
          workStatusHiddenSections: state.workStatusHiddenSections,
          isSessionSwitcherOpen: state.isSessionSwitcherOpen,
          sidebarSection: state.sidebarSection,
          settingsPage: state.settingsPage,
          settingsHasOpenedOnce: state.settingsHasOpenedOnce,
          settingsProjectsSelectedId: state.settingsProjectsSelectedId,
          settingsRemoteInstancesSelectedId: state.settingsRemoteInstancesSelectedId,
          isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
          // Note: isSettingsDialogOpen intentionally NOT persisted
          showReasoningTraces: state.showReasoningTraces,
          streamingAutoFollowEnabled: state.streamingAutoFollowEnabled,
          sessionRecapEnabled: state.sessionRecapEnabled,
          sessionSuggestionEnabled: state.sessionSuggestionEnabled,
          sessionGoalEnabled: state.sessionGoalEnabled,
          sessionGoalDefaultBudgetEnabled: state.sessionGoalDefaultBudgetEnabled,
          sessionGoalDefaultBudget: state.sessionGoalDefaultBudget,
          collapsibleThinkingBlocks: state.collapsibleThinkingBlocks,
          chatRenderMode: state.chatRenderMode,
          activityRenderMode: state.activityRenderMode,
          showDeletionDialog: state.showDeletionDialog,
          showOpenCodeRestartConfirm: state.showOpenCodeRestartConfirm,
          autoDeleteEnabled: state.autoDeleteEnabled,
          autoSaveEnabled: state.autoSaveEnabled,
          autoDeleteAfterDays: state.autoDeleteAfterDays,
          sessionRetentionAction: state.sessionRetentionAction,
          autoDeleteLastRunAt: state.autoDeleteLastRunAt,
          messageLimit: state.messageLimit,
          fontSize: state.fontSize,
          globalDraftStarters: state.globalDraftStarters,
          terminalFontSize: state.terminalFontSize,
          terminalShell: state.terminalShell,
          terminalLoginShells: state.terminalLoginShells,
          editorFontSize: state.editorFontSize,
          uiFont: state.uiFont,
          monoFont: state.monoFont,
          padding: state.padding,
          cornerRadius: state.cornerRadius,
          favoriteModels: state.favoriteModels,
          hiddenModels: state.hiddenModels,
          providerOrder: state.providerOrder,
          collapsedModelProviders: state.collapsedModelProviders,
          recentModels: state.recentModels,
          recentAgents: state.recentAgents,
          recentEfforts: state.recentEfforts,
          diffLayoutPreference: state.diffLayoutPreference,
          diffWrapLines: state.diffWrapLines,
          walkthroughTocWidth: state.walkthroughTocWidth,
          gitChangesViewMode: state.gitChangesViewMode,
          linearIssueListStatus: state.linearIssueListStatus,
          linearIssueListAssignee: state.linearIssueListAssignee,
          linearIssueListTeamId: state.linearIssueListTeamId,
          linearIssueListPriority: state.linearIssueListPriority,
          nativeNotificationsEnabled: state.nativeNotificationsEnabled,
          notificationMode: state.notificationMode,
          showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
          sessionTabsEnabled: state.sessionTabsEnabled,
          notifyOnSubtasks: state.notifyOnSubtasks,
          dockBadgeEnabled: state.dockBadgeEnabled,
          notifyOnCompletion: state.notifyOnCompletion,
          notifyOnError: state.notifyOnError,
          notifyOnQuestion: state.notifyOnQuestion,
          notificationTemplates: state.notificationTemplates,
          summarizeLastMessage: state.summarizeLastMessage,
          summaryThreshold: state.summaryThreshold,
          summaryLength: state.summaryLength,
          maxLastMessageLength: state.maxLastMessageLength,
          persistChatDraft: state.persistChatDraft,
          showOpenCodeUpdateNotifications: state.showOpenCodeUpdateNotifications,
          agentControlToolEnabled: state.agentControlToolEnabled,
          agentWebToolEnabled: state.agentWebToolEnabled,
          agentMemoryToolEnabled: state.agentMemoryToolEnabled,
          agentMemoryViewedAt: state.agentMemoryViewedAt,
          projectContextSidebarWidth: state.projectContextSidebarWidth,
          inputSpellcheckEnabled: state.inputSpellcheckEnabled,
          largeTextPasteBehavior: state.largeTextPasteBehavior,
          wideChatLayoutEnabled: state.wideChatLayoutEnabled,
          codeBlockLineWrap: state.codeBlockLineWrap,
          showToolFileIcons: state.showToolFileIcons,
          showTurnChangedFiles: state.showTurnChangedFiles,
          showExpandedBashTools: state.showExpandedBashTools,
          showExpandedEditTools: state.showExpandedEditTools,
          timeFormatPreference: state.timeFormatPreference,
          weekStartPreference: state.weekStartPreference,
          desktopWindowControlsPosition: state.desktopWindowControlsPosition,
          desktopWindowControlsStyle: state.desktopWindowControlsStyle,
          mermaidRenderingMode: state.mermaidRenderingMode,
          userMessageRenderingMode: state.userMessageRenderingMode,
          collapsibleUserMessages: state.collapsibleUserMessages,
          stickyUserHeader: state.stickyUserHeader,
          promptNavigatorEnabled: state.promptNavigatorEnabled,
          showSplitAssistantMessageActions: state.showSplitAssistantMessageActions,
          allowPromptingSubagentSessions: state.allowPromptingSubagentSessions,
          draftStartersVisible: state.draftStartersVisible,
          shortcutOverrides: state.shortcutOverrides,
          fileEditorKeymap: state.fileEditorKeymap,
        })
      }
    ),
    {
      name: 'ui-store'
    }
  )
);
