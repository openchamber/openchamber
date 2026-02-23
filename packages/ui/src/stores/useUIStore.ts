import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { SidebarSection } from '@/constants/sidebar';
import { getSafeStorage } from './utils/safeStorage';
import { SEMANTIC_TYPOGRAPHY, getTypographyVariable, type SemanticTypographyKey } from '@/lib/typography';
import type { ShortcutCombo } from '@/lib/shortcuts';

export type MainTab = 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files';
export type RightSidebarTab = 'git' | 'files';
export type ContextPanelMode = 'diff' | 'file' | 'context' | 'plan';

type ContextPanelDirectoryState = {
  isOpen: boolean;
  expanded: boolean;
  mode: ContextPanelMode | null;
  targetPath: string | null;
  width: number;
  touchedAt: number;
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

const touchContextPanelState = (prev?: ContextPanelDirectoryState): ContextPanelDirectoryState => {
  if (prev) {
    return { ...prev, touchedAt: Date.now() };
  }

  return {
    isOpen: false,
    expanded: false,
    mode: null,
    targetPath: null,
    width: CONTEXT_PANEL_DEFAULT_WIDTH,
    touchedAt: Date.now(),
  };
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
  eventStreamStatus: EventStreamStatus;
  eventStreamHint: string | null;
  showReasoningTraces: boolean;
  showTextJustificationActivity: boolean;
  showDeletionDialog: boolean;
  autoDeleteEnabled: boolean;
  autoDeleteAfterDays: number;
  autoDeleteLastRunAt: number | null;
  messageLimit: number;

  toolCallExpansion: 'collapsed' | 'activity' | 'detailed';
  fontSize: number;
  terminalFontSize: number;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;

  favoriteModels: Array<{ providerID: string; modelID: string }>;
  hiddenModels: Array<{ providerID: string; modelID: string }>;
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
  isMobileSessionStatusBarCollapsed: boolean;

  isExpandedInput: boolean;

  shortcutOverrides: Record<string, ShortcutCombo>;

  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarOpen: (open: boolean) => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: RightSidebarTab) => void;
  openContextDiff: (directory: string, filePath: string) => void;
  openContextFile: (directory: string, filePath: string) => void;
  openContextOverview: (directory: string) => void;
  openContextPlan: (directory: string) => void;
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
  setEventStreamStatus: (status: EventStreamStatus, hint?: string | null) => void;
  setShowReasoningTraces: (value: boolean) => void;
  setShowTextJustificationActivity: (value: boolean) => void;
  setShowDeletionDialog: (value: boolean) => void;
  setAutoDeleteEnabled: (value: boolean) => void;
  setAutoDeleteAfterDays: (days: number) => void;
  setAutoDeleteLastRunAt: (timestamp: number | null) => void;
  setMessageLimit: (value: number) => void;
  setToolCallExpansion: (value: 'collapsed' | 'activity' | 'detailed') => void;
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
  setIsMobileSessionStatusBarCollapsed: (value: boolean) => void;
  toggleExpandedInput: () => void;
  setExpandedInput: (value: boolean) => void;
  openMultiRunLauncher: () => void;
  openMultiRunLauncherWithPrompt: (prompt: string) => void;
  setShortcutOverride: (actionId: string, combo: ShortcutCombo) => void;
  clearShortcutOverride: (actionId: string) => void;
  resetAllShortcutOverrides: () => void;
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
        eventStreamStatus: 'idle',
        eventStreamHint: null,
        showReasoningTraces: true,
        showTextJustificationActivity: false,
        showDeletionDialog: true,
        autoDeleteEnabled: false,
        autoDeleteAfterDays: 30,
        autoDeleteLastRunAt: null,
        messageLimit: 200,
        toolCallExpansion: 'collapsed',
        fontSize: 100,
        terminalFontSize: 13,
        padding: 100,
        cornerRadius: 12,
        inputBarOffset: 0,
        favoriteModels: [],
        hiddenModels: [],
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
        isMobileSessionStatusBarCollapsed: false,
        isExpandedInput: false,
        shortcutOverrides: {},

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

        openContextDiff: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = (filePath || '').trim();
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                isOpen: true,
                mode: 'diff' as const,
                targetPath: normalizedFilePath,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
          get().setPendingDiffFile(normalizedFilePath);
        },

        openContextFile: (directory, filePath) => {
          const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
          const normalizedFilePath = (filePath || '').trim();
          if (!normalizedDirectory || !normalizedFilePath) {
            return;
          }

          set((state) => {
            const prev = state.contextPanelByDirectory[normalizedDirectory];
            const current = touchContextPanelState(prev);
            const byDirectory = {
              ...state.contextPanelByDirectory,
              [normalizedDirectory]: {
                ...current,
                isOpen: true,
                mode: 'file' as const,
                targetPath: normalizedFilePath,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        openContextOverview: (directory) => {
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
                isOpen: true,
                mode: 'context' as const,
                targetPath: null,
              },
            };

            return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
          });
        },

        openContextPlan: (directory) => {
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
                isOpen: true,
                mode: 'plan' as const,
                targetPath: null,
              },
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

        setEventStreamStatus: (status, hint) => {
          set({
            eventStreamStatus: status,
            eventStreamHint: hint ?? null,
          });
        },

        setShowReasoningTraces: (value) => {
          set({ showReasoningTraces: value });
        },

        setShowTextJustificationActivity: (value) => {
          set({ showTextJustificationActivity: value });
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

        setAutoDeleteLastRunAt: (timestamp) => {
          set({ autoDeleteLastRunAt: timestamp });
        },

        setMessageLimit: (value) => {
          const clamped = Math.max(10, Math.min(500, Math.round(value)));
          set({ messageLimit: clamped });
        },

        setToolCallExpansion: (value) => {
          set({ toolCallExpansion: value });
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
        setIsMobileSessionStatusBarCollapsed: (value) => {
          set({ isMobileSessionStatusBarCollapsed: value });
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
        version: 5,
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

          if (!state.contextPanelByDirectory || typeof state.contextPanelByDirectory !== 'object') {
            state.contextPanelByDirectory = {};
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

          return state;
        },
        partialize: (state) => ({
          theme: state.theme,
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
          isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
          // Note: isSettingsDialogOpen intentionally NOT persisted
          showReasoningTraces: state.showReasoningTraces,
          showTextJustificationActivity: state.showTextJustificationActivity,
          showDeletionDialog: state.showDeletionDialog,
          autoDeleteEnabled: state.autoDeleteEnabled,
          autoDeleteAfterDays: state.autoDeleteAfterDays,
          autoDeleteLastRunAt: state.autoDeleteLastRunAt,
          messageLimit: state.messageLimit,
          toolCallExpansion: state.toolCallExpansion,
          fontSize: state.fontSize,
          terminalFontSize: state.terminalFontSize,
          padding: state.padding,
          cornerRadius: state.cornerRadius,
          favoriteModels: state.favoriteModels,
          hiddenModels: state.hiddenModels,
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
