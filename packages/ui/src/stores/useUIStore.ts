import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { SidebarSection } from '@/constants/sidebar';
import { getSafeStorage } from './utils/safeStorage';
import { SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '@/lib/typography';
import type { ShortcutCombo } from '@/lib/shortcuts';

export type MainTab = 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files';
export type RightSidebarTab = 'git' | 'files';
export type ContextPanelMode = 'diff' | 'file' | 'context' | 'plan' | 'chat';
export type MermaidRenderingMode = 'svg' | 'ascii';
export type UserMessageRenderingMode = 'markdown' | 'plain';
export type ChatRenderMode = 'sorted' | 'live';
export type ActivityRenderMode = 'collapsed' | 'summary';
export type SessionRetentionAction = 'archive' | 'delete';

type ContextPanelTab = {
  id: string;
  mode: ContextPanelMode;
  targetPath: string | null;
  dedupeKey: string;
  label: string | null;
  touchedAt: number;
};

type ContextPanelTabDescriptor = {
  mode: ContextPanelMode;
  targetPath?: string | null;
  dedupeKey?: string | null;
  label?: string | null;
};

type ContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  tabs: ContextPanelTab[];
  activeTabId: string | null;
  width: number;
  touchedAt: number;
};

type PendingFileNavigation = {
  path: string;
  line: number;
  column: number;
};

export type MainTabGuard = (nextTab: MainTab) => boolean;
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

const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const CONTEXT_PANEL_MIN_WIDTH = 360;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_MAX_TABS = 12;
const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;
const LEFT_SIDEBAR_MIN_WIDTH = 300;
const RIGHT_SIDEBAR_MIN_WIDTH = 400;

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

const buildDefaultContextPanelTabDedupeKey = (mode: ContextPanelMode, targetPath: string | null): string => {
  if (mode === 'file') {
    return targetPath || mode;
  }

  return mode;
};

const normalizeContextPanelTabDedupeKey = (
  mode: ContextPanelMode,
  targetPath: string | null,
  dedupeKey: string | null | undefined,
): string => {
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
    dedupeKey,
    label: normalizeContextTabLabel(descriptor.label),
    touchedAt: Date.now(),
  };
};

const clampContextPanelTabs = (tabs: ContextPanelTab[], maxTabs: number, activeTabId: string | null): ContextPanelTab[] => {
  if (tabs.length <= maxTabs) {
    return tabs;
  }

  const tabsByTouch = [...tabs].sort((a, b) => a.touchedAt - b.touchedAt);
  const removable = tabsByTouch.filter((tab) => tab.id !== activeTabId);
  const removeCount = tabs.length - maxTabs;
  if (removeCount <= 0 || removable.length === 0) {
    return tabs.slice(-maxTabs);
  }

  const removeSet = new Set(removable.slice(0, removeCount).map((tab) => tab.id));
  return tabs.filter((tab) => !removeSet.has(tab.id));
};

const sanitizeContextPanelTabs = (tabs: unknown): ContextPanelTab[] => {
  if (!Array.isArray(tabs)) {
    return [];
  }

  const result: ContextPanelTab[] = [];
  const seen = new Set<string>();

  for (const entry of tabs) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const candidate = entry as {
      mode?: unknown;
      targetPath?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
      touchedAt?: unknown;
    };

    if (candidate.mode !== 'diff' && candidate.mode !== 'file' && candidate.mode !== 'context' && candidate.mode !== 'plan' && candidate.mode !== 'chat') {
      continue;
    }

    const targetPath = normalizeContextTargetPath(typeof candidate.targetPath === 'string' ? candidate.targetPath : null);
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
      dedupeKey,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
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
    width: CONTEXT_PANEL_DEFAULT_WIDTH,
    touchedAt: Date.now(),
  };
};

const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
): ContextPanelDirectoryState => {
  const nextTab = createContextPanelTab(descriptor);
  const existingIndex = current.tabs.findIndex((tab) => tab.id === nextTab.id);
  const tabs = existingIndex === -1
    ? [...current.tabs, nextTab]
    : current.tabs.map((tab, index) => (index === existingIndex
      ? {
          ...tab,
          mode: nextTab.mode,
          targetPath: nextTab.targetPath,
          dedupeKey: nextTab.dedupeKey,
          label: nextTab.label,
          touchedAt: Date.now(),
        }
      : tab));

  const activeTabId = nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return {
    ...current,
    isOpen: true,
    tabs: clampedTabs,
    activeTabId: resolveActiveContextPanelTabID(clampedTabs, activeTabId),
    touchedAt: Date.now(),
  };
};

const closeContextPanelTab = (
  current: ContextPanelDirectoryState,
  tabID: string,
): ContextPanelDirectoryState => {
  const nextTabs = current.tabs.filter((tab) => tab.id !== tabID);
  const nextActiveTabId = current.activeTabId === tabID
    ? (nextTabs[nextTabs.length - 1]?.id ?? null)
    : resolveActiveContextPanelTabID(nextTabs, current.activeTabId);

  return {
    ...current,
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    isOpen: nextTabs.length > 0 ? current.isOpen : false,
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
      width?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
    };

    let tabs = sanitizeContextPanelTabs(candidate.tabs);
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

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

    next[directory] = {
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId),
      width: clampContextPanelWidth(typeof candidate.width === 'number' ? candidate.width : CONTEXT_PANEL_DEFAULT_WIDTH),
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
  language: string;
  isMultiRunLauncherOpen: boolean;
  multiRunLauncherPrefillPrompt: string;
  isSidebarOpen: boolean;
  sidebarWidth: number;
  hasManuallyResizedLeftSidebar: boolean;
  isRightSidebarOpen: boolean;
  rightSidebarWidth: number;
  hasManuallyResizedRightSidebar: boolean;
  rightSidebarTab: RightSidebarTab;
  contextPanelByDirectory: Record<string, ContextPanelDirectoryState>;
  isBottomTerminalOpen: boolean;
  isBottomTerminalExpanded: boolean;
  bottomTerminalHeight: number;
  hasManuallyResizedBottomTerminal: boolean;
  isSessionSwitcherOpen: boolean;
  activeMainTab: MainTab;
  mainTabGuard: MainTabGuard | null;
  sidebarOpenBeforeFullscreenTab: boolean | null;
  pendingDiffFile: string | null;
  pendingFileNavigation: PendingFileNavigation | null;
  pendingFileFocusPath: string | null;
  isMobile: boolean;
  isKeyboardOpen: boolean;
  isCommandPaletteOpen: boolean;
  isHelpDialogOpen: boolean;
  isAboutDialogOpen: boolean;
  isOpenCodeStatusDialogOpen: boolean;
  openCodeStatusText: string;
  isSessionCreateDialogOpen: boolean;
  isSettingsDialogOpen: boolean;
  isModelSelectorOpen: boolean;
  sidebarSection: SidebarSection;

  // Settings IA (new shell)
  settingsPage: string;
  settingsHasOpenedOnce: boolean;
  settingsProjectsSelectedId: string | null;
  settingsRemoteInstancesSelectedId: string | null;
  eventStreamStatus: EventStreamStatus;
  eventStreamHint: string | null;
  showReasoningTraces: boolean;
  chatRenderMode: ChatRenderMode;
  activityRenderMode: ActivityRenderMode;
  showDeletionDialog: boolean;
  autoDeleteEnabled: boolean;
  autoDeleteAfterDays: number;
  sessionRetentionAction: SessionRetentionAction;
  autoDeleteLastRunAt: number | null;
  messageLimit: number;
  fontSize: number;
  terminalFontSize: number;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;

  favoriteModels: Array<{ providerID: string; modelID: string }>;
  hiddenModels: Array<{ providerID: string; modelID: string }>;
  collapsedModelProviders: string[];
  recentModels: Array<{ providerID: string; modelID: string }>;
  recentAgents: string[];
  recentEfforts: Record<string, string[]>;

  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
  diffWrapLines: boolean;
  diffViewMode: 'single' | 'stacked';
  isTimelineDialogOpen: boolean;
  isImagePreviewOpen: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnSubtasks: boolean;

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
  persistChatDraft: boolean;
  inputSpellcheckEnabled: boolean;
  showToolFileIcons: boolean;
  showExpandedBashTools: boolean;
  showExpandedEditTools: boolean;
  mermaidRenderingMode: MermaidRenderingMode;
  userMessageRenderingMode: UserMessageRenderingMode;
  stickyUserHeader: boolean;
  showMobileSessionStatusBar: boolean;
  isMobileSessionStatusBarCollapsed: boolean;
  isExpandedInput: boolean;
  reportUsage: boolean;
  shortcutOverrides: Record<string, ShortcutCombo>;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLanguage: (language: string) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarOpen: (open: boolean) => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: RightSidebarTab) => void;
  openContextPanelTab: (directory: string, tab: ContextPanelTabDescriptor) => void;
  openContextDiff: (directory: string, filePath: string) => void;
  openContextFile: (directory: string, filePath: string) => void;
  openContextFileAtLine: (directory: string, filePath: string, line: number, column?: number) => void;
  openContextOverview: (directory: string) => void;
  openContextPlan: (directory: string) => void;
  setActiveContextPanelTab: (directory: string, tabID: string) => void;
  reorderContextPanelTabs: (directory: string, activeTabID: string, overTabID: string) => void;
  closeContextPanelTab: (directory: string, tabID: string) => void;
  closeContextPanel: (directory: string) => void;
  toggleContextPanelExpanded: (directory: string) => void;
  setContextPanelWidth: (directory: string, width: number) => void;
  toggleBottomTerminal: () => void;
  setBottomTerminalOpen: (open: boolean) => void;
  setBottomTerminalExpanded: (expanded: boolean) => void;
  setBottomTerminalHeight: (height: number) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setMainTabGuard: (guard: MainTabGuard | null) => void;
  setPendingDiffFile: (filePath: string | null) => void;
  setPendingFileNavigation: (navigation: PendingFileNavigation | null) => void;
  setPendingFileFocusPath: (path: string | null) => void;
  navigateToDiff: (filePath: string) => void;
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
  setSettingsDialogOpen: (open: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;
  applyTheme: () => void;
  setSidebarSection: (section: SidebarSection) => void;
  setSettingsPage: (slug: string) => void;
  setSettingsProjectsSelectedId: (projectId: string | null) => void;
  setSettingsRemoteInstancesSelectedId: (instanceId: string | null) => void;
  setEventStreamStatus: (status: EventStreamStatus, hint?: string | null) => void;
  setShowReasoningTraces: (value: boolean) => void;
  setChatRenderMode: (value: ChatRenderMode) => void;
  setActivityRenderMode: (value: ActivityRenderMode) => void;
  setShowDeletionDialog: (value: boolean) => void;
  setAutoDeleteEnabled: (value: boolean) => void;
  setAutoDeleteAfterDays: (days: number) => void;
  setSessionRetentionAction: (value: SessionRetentionAction) => void;
  setAutoDeleteLastRunAt: (timestamp: number | null) => void;
  setMessageLimit: (value: number) => void;
  setFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
  setPadding: (size: number) => void;
  setCornerRadius: (radius: number) => void;
  setInputBarOffset: (offset: number) => void;
  setKeyboardOpen: (open: boolean) => void;
  applyTypography: () => void;
  applyPadding: () => void;
  updateProportionalSidebarWidths: () => void;
  toggleFavoriteModel: (providerID: string, modelID: string) => void;
  toggleHiddenModel: (providerID: string, modelID: string) => void;
  isHiddenModel: (providerID: string, modelID: string) => boolean;
  hideAllModels: (providerID: string, modelIDs: string[]) => void;
  showAllModels: (providerID: string) => void;
  toggleModelProviderCollapsed: (providerID: string) => void;
  isFavoriteModel: (providerID: string, modelID: string) => boolean;
  addRecentModel: (providerID: string, modelID: string) => void;
  addRecentAgent: (agentName: string) => void;
  addRecentEffort: (providerID: string, modelID: string, variant: string | undefined) => void;
  setDiffLayoutPreference: (mode: 'dynamic' | 'inline' | 'side-by-side') => void;
  setDiffFileLayout: (filePath: string, mode: 'inline' | 'side-by-side') => void;
  setDiffWrapLines: (wrap: boolean) => void;
  setDiffViewMode: (mode: 'single' | 'stacked') => void;
  setMultiRunLauncherOpen: (open: boolean) => void;
  setTimelineDialogOpen: (open: boolean) => void;
  setImagePreviewOpen: (open: boolean) => void;
  setNativeNotificationsEnabled: (value: boolean) => void;
  setNotificationMode: (mode: 'always' | 'hidden-only') => void;
  setShowTerminalQuickKeysOnDesktop: (value: boolean) => void;
  setNotifyOnSubtasks: (value: boolean) => void;
  setNotifyOnCompletion: (value: boolean) => void;
  setNotifyOnError: (value: boolean) => void;
  setNotifyOnQuestion: (value: boolean) => void;
  setNotificationTemplates: (templates: UIStore['notificationTemplates']) => void;
  setSummarizeLastMessage: (value: boolean) => void;
  setSummaryThreshold: (value: number) => void;
  setSummaryLength: (value: number) => void;
  setMaxLastMessageLength: (value: number) => void;
  setPersistChatDraft: (value: boolean) => void;
  setInputSpellcheckEnabled: (value: boolean) => void;
  setShowToolFileIcons: (value: boolean) => void;
  setShowExpandedBashTools: (value: boolean) => void;
  setShowExpandedEditTools: (value: boolean) => void;
  setMermaidRenderingMode: (value: MermaidRenderingMode) => void;
  setUserMessageRenderingMode: (value: UserMessageRenderingMode) => void;
  setStickyUserHeader: (value: boolean) => void;
  setShowMobileSessionStatusBar: (value: boolean) => void;
  setIsMobileSessionStatusBarCollapsed: (value: boolean) => void;
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
}


export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set, get) => ({

        theme: 'system',
        language: 'en',
        isMultiRunLauncherOpen: false,
        multiRunLauncherPrefillPrompt: '',
        isSidebarOpen: true,
        sidebarWidth: LEFT_SIDEBAR_MIN_WIDTH,
        hasManuallyResizedLeftSidebar: false,
        isRightSidebarOpen: false,
        rightSidebarWidth: RIGHT_SIDEBAR_MIN_WIDTH,
        hasManuallyResizedRightSidebar: false,
        rightSidebarTab: 'git',
        contextPanelByDirectory: {},
        isBottomTerminalOpen: false,
        isBottomTerminalExpanded: false,
        bottomTerminalHeight: 300,
        hasManuallyResizedBottomTerminal: false,
        isSessionSwitcherOpen: false,
        activeMainTab: 'chat',
        mainTabGuard: null,
        sidebarOpenBeforeFullscreenTab: null,
        pendingDiffFile: null,
        pendingFileNavigation: null,
        pendingFileFocusPath: null,
        isMobile: false,
        isKeyboardOpen: false,
        isCommandPaletteOpen: false,
        isHelpDialogOpen: false,
        isAboutDialogOpen: false,
        isOpenCodeStatusDialogOpen: false,
        openCodeStatusText: '',
        isSessionCreateDialogOpen: false,
        isSettingsDialogOpen: false,
        isModelSelectorOpen: false,
        sidebarSection: 'sessions',
        settingsPage: 'home',
        settingsHasOpenedOnce: false,
        settingsProjectsSelectedId: null,
        settingsRemoteInstancesSelectedId: null,
        eventStreamStatus: 'idle',
        eventStreamHint: null,
        showReasoningTraces: true,
        chatRenderMode: 'sorted',
        activityRenderMode: 'summary',
        showDeletionDialog: true,
        autoDeleteEnabled: false,
        autoDeleteAfterDays: 30,
        sessionRetentionAction: 'archive',
        autoDeleteLastRunAt: null,
        messageLimit: 200,
        fontSize: 100,
        terminalFontSize: 13,
        padding: 100,
        cornerRadius: 18,
        inputBarOffset: 0,
        favoriteModels: [],
        hiddenModels: [],
        collapsedModelProviders: [],
        recentModels: [],
        recentAgents: [],
        recentEfforts: {},
        diffLayoutPreference: 'inline',
        diffFileLayout: {},
        diffWrapLines: false,
        diffViewMode: 'stacked',
        isTimelineDialogOpen: false,
        isImagePreviewOpen: false,
        nativeNotificationsEnabled: false,
        notificationMode: 'hidden-only',
        notifyOnSubtasks: true,

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
        persistChatDraft: true,
        inputSpellcheckEnabled: false,
        showToolFileIcons: true,
        showExpandedBashTools: false,
        showExpandedEditTools: false,
        mermaidRenderingMode: 'svg',
        userMessageRenderingMode: 'markdown',
        stickyUserHeader: true,
        showMobileSessionStatusBar: true,
        isMobileSessionStatusBarCollapsed: false,
        isExpandedInput: false,
        reportUsage: true,
        shortcutOverrides: {},

        setTheme: (theme) => {
          set({ theme });
          get().applyTheme();
        },

        setLanguage: (language) => {
          set({ language });
          void import('../i18n').then((mod) =>
            mod.default.changeLanguage(language),
          );
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

        toggleRightSidebar: () => {
          set((state) => {
            const newOpen = !state.isRightSidebarOpen;

            if (newOpen && !state.hasManuallyResizedRightSidebar) {
              return {
                isRightSidebarOpen: newOpen,
                rightSidebarWidth: RIGHT_SIDEBAR_MIN_WIDTH,
              };
            }
            return { isRightSidebarOpen: newOpen };
          });
        },

        setRightSidebarOpen: (open) => {
          set((state) => {
            if (state.isRightSidebarOpen === open) {
              if (!open) {
                return state;
              }
              if (!state.hasManuallyResizedRightSidebar && state.rightSidebarWidth !== RIGHT_SIDEBAR_MIN_WIDTH) {
                return {
                  isRightSidebarOpen: open,
                  rightSidebarWidth: RIGHT_SIDEBAR_MIN_WIDTH,
                };
              }
              return state;
            }
            if (open && !state.hasManuallyResizedRightSidebar) {
              return {
                isRightSidebarOpen: open,
                rightSidebarWidth: RIGHT_SIDEBAR_MIN_WIDTH,
              };
            }
            return { isRightSidebarOpen: open };
          });
        },

        setRightSidebarWidth: (width) => {
          set({ rightSidebarWidth: width, hasManuallyResizedRightSidebar: true });
        },

        setRightSidebarTab: (tab) => {
          set({ rightSidebarTab: tab });
        },

        openContextPanelTab: (directory, tab) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: upsertContextPanelTab(current, tab),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        openContextDiff: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = (filePath || '').trim();
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'diff', targetPath: normalizedFilePath });
          get().setPendingDiffFile(normalizedFilePath);
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

        openContextPlan: (directory) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          if (!normalizedDirectory) {
            return;
          }

          get().openContextPanelTab(normalizedDirectory, { mode: 'plan' });
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

            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: closeContextPanelTab(current, normalizedTabID),
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
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

        setContextPanelWidth: (directory, width) => {
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
                width: clampContextPanelWidth(width),
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        toggleBottomTerminal: () => {
          set((state) => {
            const newOpen = !state.isBottomTerminalOpen;

            if (newOpen && typeof window !== 'undefined') {
              const proportionalHeight = Math.floor(window.innerHeight * 0.32);
              return {
                isBottomTerminalOpen: newOpen,
                bottomTerminalHeight: proportionalHeight,
                hasManuallyResizedBottomTerminal: false,
              };
            }

            return { isBottomTerminalOpen: newOpen };
          });
        },

        setBottomTerminalOpen: (open) => {
          set((state) => {
            if (state.isBottomTerminalOpen === open) {
              if (!open) {
                return state;
              }
              if (!state.hasManuallyResizedBottomTerminal && typeof window !== 'undefined') {
                const proportionalHeight = Math.floor(window.innerHeight * 0.32);
                if (state.bottomTerminalHeight === proportionalHeight && state.hasManuallyResizedBottomTerminal === false) {
                  return state;
                }
                return {
                  isBottomTerminalOpen: open,
                  bottomTerminalHeight: proportionalHeight,
                  hasManuallyResizedBottomTerminal: false,
                };
              }
              return state;
            }

            if (open && typeof window !== 'undefined') {
              const proportionalHeight = Math.floor(window.innerHeight * 0.32);
              return {
                isBottomTerminalOpen: open,
                bottomTerminalHeight: proportionalHeight,
                hasManuallyResizedBottomTerminal: false,
              };
            }

            return { isBottomTerminalOpen: open };
          });
        },

        setBottomTerminalExpanded: (expanded) => {
          set({ isBottomTerminalExpanded: expanded });
        },

        setBottomTerminalHeight: (height) => {
          set({ bottomTerminalHeight: height, hasManuallyResizedBottomTerminal: true });
        },

        setSessionSwitcherOpen: (open) => {
          set({ isSessionSwitcherOpen: open });
        },

        setMainTabGuard: (guard) => {
          if (get().mainTabGuard === guard) {
            return;
          }
          set({ mainTabGuard: guard });
        },

        setActiveMainTab: (tab) => {
          const guard = get().mainTabGuard;
          if (guard && !guard(tab)) {
            return;
          }
          set({ activeMainTab: tab });
        },

        setPendingDiffFile: (filePath) => {
          set({ pendingDiffFile: filePath });
        },

        setPendingFileNavigation: (navigation) => {
          set({ pendingFileNavigation: navigation });
        },

        setPendingFileFocusPath: (path) => {
          set({ pendingFileFocusPath: path });
        },

        navigateToDiff: (filePath) => {
          const guard = get().mainTabGuard;
          if (guard && !guard('diff')) {
            return;
          }
          set({ pendingDiffFile: filePath, activeMainTab: 'diff' });
        },

        consumePendingDiffFile: () => {
          const { pendingDiffFile } = get();
          if (pendingDiffFile) {
            set({ pendingDiffFile: null });
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

        setModelSelectorOpen: (open) => {
          set({ isModelSelectorOpen: open });
        },

        setSidebarSection: (section) => {
          set({ sidebarSection: section });
        },

        setSettingsPage: (slug) => {
          set({ settingsPage: slug });
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

        setChatRenderMode: (value) => {
          set({ chatRenderMode: value });
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

        setTerminalFontSize: (size) => {
          const rounded = Math.round(size);
          const clamped = Math.max(9, Math.min(52, rounded));
          set({ terminalFontSize: clamped });
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

        setDiffViewMode: (mode) => {
          set({ diffViewMode: mode });
        },
 
        setInputBarOffset: (offset) => {
          set({ inputBarOffset: offset });
        },

        setKeyboardOpen: (open) => {
          set({ isKeyboardOpen: open });
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

        updateProportionalSidebarWidths: () => {
          if (typeof window === 'undefined') {
            return;
          }

          set((state) => {
            const updates: Partial<UIStore> = {};

            if (state.isBottomTerminalOpen && !state.hasManuallyResizedBottomTerminal) {
              updates.bottomTerminalHeight = Math.floor(window.innerHeight * 0.32);
            }

            return updates;
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

        setMultiRunLauncherOpen: (open) => {
          set((state) => ({
            isMultiRunLauncherOpen: open,
            multiRunLauncherPrefillPrompt: open ? state.multiRunLauncherPrefillPrompt : '',
          }));
        },

        openMultiRunLauncher: () => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: '',
            isSessionSwitcherOpen: false,
          });
        },

        openMultiRunLauncherWithPrompt: (prompt) => {
          set({
            isMultiRunLauncherOpen: true,
            multiRunLauncherPrefillPrompt: prompt,
            isSessionSwitcherOpen: false,
          });
        },

        setTimelineDialogOpen: (open) => {
          set({ isTimelineDialogOpen: open });
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

        setNotifyOnSubtasks: (value) => {
          set({ notifyOnSubtasks: value });
        },

        setNotifyOnCompletion: (value) => { set({ notifyOnCompletion: value }); },
        setNotifyOnError: (value) => { set({ notifyOnError: value }); },
        setNotifyOnQuestion: (value) => { set({ notifyOnQuestion: value }); },
        setNotificationTemplates: (templates) => { set({ notificationTemplates: templates }); },
        setSummarizeLastMessage: (value) => { set({ summarizeLastMessage: value }); },
        setSummaryThreshold: (value) => { set({ summaryThreshold: value }); },
        setSummaryLength: (value) => { set({ summaryLength: value }); },
        setMaxLastMessageLength: (value) => { set({ maxLastMessageLength: value }); },
        setPersistChatDraft: (value) => {
          set({ persistChatDraft: value });
        },
        setInputSpellcheckEnabled: (value) => {
          set({ inputSpellcheckEnabled: value });
        },
        setShowToolFileIcons: (value) => {
          set({ showToolFileIcons: value });
        },
        setShowExpandedBashTools: (value) => {
          set({ showExpandedBashTools: value });
        },
        setShowExpandedEditTools: (value) => {
          set({ showExpandedEditTools: value });
        },
        setMermaidRenderingMode: (value) => {
          set({ mermaidRenderingMode: value });
        },
        setUserMessageRenderingMode: (value) => {
          set({ userMessageRenderingMode: value });
        },
        setStickyUserHeader: (value) => {
          set({ stickyUserHeader: value });
        },
        setShowMobileSessionStatusBar: (value) => {
          set({ showMobileSessionStatusBar: value });
        },
        setIsMobileSessionStatusBarCollapsed: (value) => {
          set({ isMobileSessionStatusBarCollapsed: value });
        },
        setReportUsage: (value) => {
          set({ reportUsage: value });
        },
        viewPagerPage: 'center',
        setViewPagerPage: (page: 'left' | 'center' | 'right') => {
          set({ viewPagerPage: page });
          if (page === 'left') {
            set({ isSessionSwitcherOpen: true, isRightSidebarOpen: false });
          } else if (page === 'right') {
            set({ isRightSidebarOpen: true, isSessionSwitcherOpen: false });
          } else {
            set({ isSessionSwitcherOpen: false, isRightSidebarOpen: false });
          }
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

        toggleExpandedInput: () => {
          set((state) => ({ isExpandedInput: !state.isExpandedInput }));
        },

        setExpandedInput: (value) => {
          set({ isExpandedInput: value });
        },
      }),
      {
        name: 'ui-store',
        storage: createJSONStorage(() => getSafeStorage()),
        version: 8,
        migrate: (persistedState, version) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return persistedState;
          }
          const state = persistedState as Record<string, unknown>;

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

          if (typeof state.rightSidebarTab !== 'string' || (state.rightSidebarTab !== 'git' && state.rightSidebarTab !== 'files')) {
            state.rightSidebarTab = 'git';
          }

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
            if (typeof state.language !== 'string' || !state.language) {
              state.language = 'en';
            }
          }

          return state;
        },
        partialize: (state) => ({
          theme: state.theme,
          language: state.language,
          isSidebarOpen: state.isSidebarOpen,
          sidebarWidth: state.sidebarWidth,
          isRightSidebarOpen: state.isRightSidebarOpen,
          rightSidebarWidth: state.rightSidebarWidth,
          rightSidebarTab: state.rightSidebarTab,
          contextPanelByDirectory: state.contextPanelByDirectory,
          isBottomTerminalOpen: state.isBottomTerminalOpen,
          isBottomTerminalExpanded: state.isBottomTerminalExpanded,
          bottomTerminalHeight: state.bottomTerminalHeight,
          isSessionSwitcherOpen: state.isSessionSwitcherOpen,
          activeMainTab: state.activeMainTab,
          sidebarSection: state.sidebarSection,
          settingsPage: state.settingsPage,
          settingsHasOpenedOnce: state.settingsHasOpenedOnce,
          settingsProjectsSelectedId: state.settingsProjectsSelectedId,
          settingsRemoteInstancesSelectedId: state.settingsRemoteInstancesSelectedId,
          isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
          // Note: isSettingsDialogOpen intentionally NOT persisted
          showReasoningTraces: state.showReasoningTraces,
          chatRenderMode: state.chatRenderMode,
          activityRenderMode: state.activityRenderMode,
          showDeletionDialog: state.showDeletionDialog,
          autoDeleteEnabled: state.autoDeleteEnabled,
          autoDeleteAfterDays: state.autoDeleteAfterDays,
          sessionRetentionAction: state.sessionRetentionAction,
          autoDeleteLastRunAt: state.autoDeleteLastRunAt,
          messageLimit: state.messageLimit,
          fontSize: state.fontSize,
          terminalFontSize: state.terminalFontSize,
          padding: state.padding,
          cornerRadius: state.cornerRadius,
          favoriteModels: state.favoriteModels,
          hiddenModels: state.hiddenModels,
          collapsedModelProviders: state.collapsedModelProviders,
          recentModels: state.recentModels,
          recentAgents: state.recentAgents,
          recentEfforts: state.recentEfforts,
          diffLayoutPreference: state.diffLayoutPreference,
          diffWrapLines: state.diffWrapLines,
          diffViewMode: state.diffViewMode,
          nativeNotificationsEnabled: state.nativeNotificationsEnabled,
          notificationMode: state.notificationMode,
          showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
          notifyOnSubtasks: state.notifyOnSubtasks,
          notifyOnCompletion: state.notifyOnCompletion,
          notifyOnError: state.notifyOnError,
          notifyOnQuestion: state.notifyOnQuestion,
          notificationTemplates: state.notificationTemplates,
          summarizeLastMessage: state.summarizeLastMessage,
          summaryThreshold: state.summaryThreshold,
          summaryLength: state.summaryLength,
          maxLastMessageLength: state.maxLastMessageLength,
          persistChatDraft: state.persistChatDraft,
          inputSpellcheckEnabled: state.inputSpellcheckEnabled,
          showToolFileIcons: state.showToolFileIcons,
          showExpandedBashTools: state.showExpandedBashTools,
          showExpandedEditTools: state.showExpandedEditTools,
          mermaidRenderingMode: state.mermaidRenderingMode,
          userMessageRenderingMode: state.userMessageRenderingMode,
          stickyUserHeader: state.stickyUserHeader,
          showMobileSessionStatusBar: state.showMobileSessionStatusBar,
          isMobileSessionStatusBarCollapsed: state.isMobileSessionStatusBarCollapsed,
          shortcutOverrides: state.shortcutOverrides,
        })
      }
    ),
    {
      name: 'ui-store'
    }
  )
);
