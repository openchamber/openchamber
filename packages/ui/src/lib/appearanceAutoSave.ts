import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings } from '@/lib/desktop';

type AppearanceSlice = {
  showReasoningTraces: boolean;
  showTextJustificationActivity: boolean;
  showDeletionDialog: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnSubtasks: boolean;
  notifyOnCompletion: boolean;
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
  autoDeleteEnabled: boolean;
  autoDeleteAfterDays: number;
  toolCallExpansion: 'collapsed' | 'activity' | 'detailed';
  fontSize: number;
  terminalFontSize: number;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffViewMode: 'single' | 'stacked';
};

let initialized = false;

export const startAppearanceAutoSave = (): void => {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  initialized = true;

  let previous: AppearanceSlice = {
    showReasoningTraces: useUIStore.getState().showReasoningTraces,
    showTextJustificationActivity: useUIStore.getState().showTextJustificationActivity,
    showDeletionDialog: useUIStore.getState().showDeletionDialog,
    nativeNotificationsEnabled: useUIStore.getState().nativeNotificationsEnabled,
    notificationMode: useUIStore.getState().notificationMode,
    notifyOnSubtasks: useUIStore.getState().notifyOnSubtasks,
    notifyOnCompletion: useUIStore.getState().notifyOnCompletion,
    notifyOnError: useUIStore.getState().notifyOnError,
    notifyOnQuestion: useUIStore.getState().notifyOnQuestion,
    notificationTemplates: useUIStore.getState().notificationTemplates,
    summarizeLastMessage: useUIStore.getState().summarizeLastMessage,
    summaryThreshold: useUIStore.getState().summaryThreshold,
    summaryLength: useUIStore.getState().summaryLength,
    maxLastMessageLength: useUIStore.getState().maxLastMessageLength,
    autoDeleteEnabled: useUIStore.getState().autoDeleteEnabled,
    autoDeleteAfterDays: useUIStore.getState().autoDeleteAfterDays,
    toolCallExpansion: useUIStore.getState().toolCallExpansion,
    fontSize: useUIStore.getState().fontSize,
    terminalFontSize: useUIStore.getState().terminalFontSize,
    padding: useUIStore.getState().padding,
    cornerRadius: useUIStore.getState().cornerRadius,
    inputBarOffset: useUIStore.getState().inputBarOffset,
    diffLayoutPreference: useUIStore.getState().diffLayoutPreference,
    diffViewMode: useUIStore.getState().diffViewMode,
  };

  let pending: Partial<DesktopSettings> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    const payload = pending;
    pending = null;
    timer = null;
    if (payload && Object.keys(payload).length > 0) {
      void updateDesktopSettings(payload);
    }
  };

  const schedule = (changes: Partial<DesktopSettings>) => {
    pending = { ...(pending ?? {}), ...changes };
    if (timer) {
      return;
    }
    timer = setTimeout(flush, 150);
  };

  useUIStore.subscribe((state) => {
    const current: AppearanceSlice = {
      showReasoningTraces: state.showReasoningTraces,
      showTextJustificationActivity: state.showTextJustificationActivity,
      showDeletionDialog: state.showDeletionDialog,
      nativeNotificationsEnabled: state.nativeNotificationsEnabled,
      notificationMode: state.notificationMode,
      notifyOnSubtasks: state.notifyOnSubtasks,
      notifyOnCompletion: state.notifyOnCompletion,
      notifyOnError: state.notifyOnError,
      notifyOnQuestion: state.notifyOnQuestion,
      notificationTemplates: state.notificationTemplates,
      summarizeLastMessage: state.summarizeLastMessage,
      summaryThreshold: state.summaryThreshold,
      summaryLength: state.summaryLength,
      maxLastMessageLength: state.maxLastMessageLength,
      autoDeleteEnabled: state.autoDeleteEnabled,
      autoDeleteAfterDays: state.autoDeleteAfterDays,
      toolCallExpansion: state.toolCallExpansion,
      fontSize: state.fontSize,
      terminalFontSize: state.terminalFontSize,
      padding: state.padding,
      cornerRadius: state.cornerRadius,
      inputBarOffset: state.inputBarOffset,
      diffLayoutPreference: state.diffLayoutPreference,
      diffViewMode: state.diffViewMode,
    };

    const diff: Partial<DesktopSettings> = {};

    if (current.showReasoningTraces !== previous.showReasoningTraces) {
      diff.showReasoningTraces = current.showReasoningTraces;
    }
    if (current.showTextJustificationActivity !== previous.showTextJustificationActivity) {
      diff.showTextJustificationActivity = current.showTextJustificationActivity;
    }
    if (current.showDeletionDialog !== previous.showDeletionDialog) {
      diff.showDeletionDialog = current.showDeletionDialog;
    }
    if (current.nativeNotificationsEnabled !== previous.nativeNotificationsEnabled) {
      diff.nativeNotificationsEnabled = current.nativeNotificationsEnabled;
    }
    if (current.notificationMode !== previous.notificationMode) {
      diff.notificationMode = current.notificationMode;
    }
    if (current.notifyOnSubtasks !== previous.notifyOnSubtasks) {
      diff.notifyOnSubtasks = current.notifyOnSubtasks;
    }
    if (current.notifyOnCompletion !== previous.notifyOnCompletion) {
      diff.notifyOnCompletion = current.notifyOnCompletion;
    }
    if (current.notifyOnError !== previous.notifyOnError) {
      diff.notifyOnError = current.notifyOnError;
    }
    if (current.notifyOnQuestion !== previous.notifyOnQuestion) {
      diff.notifyOnQuestion = current.notifyOnQuestion;
    }
    if (JSON.stringify(current.notificationTemplates) !== JSON.stringify(previous.notificationTemplates)) {
      diff.notificationTemplates = current.notificationTemplates;
    }
    if (current.summarizeLastMessage !== previous.summarizeLastMessage) {
      diff.summarizeLastMessage = current.summarizeLastMessage;
    }
    if (current.summaryThreshold !== previous.summaryThreshold) {
      diff.summaryThreshold = current.summaryThreshold;
    }
    if (current.summaryLength !== previous.summaryLength) {
      diff.summaryLength = current.summaryLength;
    }
    if (current.maxLastMessageLength !== previous.maxLastMessageLength) {
      diff.maxLastMessageLength = current.maxLastMessageLength;
    }
    if (current.autoDeleteEnabled !== previous.autoDeleteEnabled) {
      diff.autoDeleteEnabled = current.autoDeleteEnabled;
    }
    if (current.autoDeleteAfterDays !== previous.autoDeleteAfterDays) {
      diff.autoDeleteAfterDays = current.autoDeleteAfterDays;
    }
    if (current.toolCallExpansion !== previous.toolCallExpansion) {
      diff.toolCallExpansion = current.toolCallExpansion;
    }
    if (current.fontSize !== previous.fontSize) {
      diff.fontSize = current.fontSize;
    }
    if (current.terminalFontSize !== previous.terminalFontSize) {
      diff.terminalFontSize = current.terminalFontSize;
    }
    if (current.padding !== previous.padding) {
      diff.padding = current.padding;
    }
    if (current.cornerRadius !== previous.cornerRadius) {
      diff.cornerRadius = current.cornerRadius;
    }
    if (current.inputBarOffset !== previous.inputBarOffset) {
      diff.inputBarOffset = current.inputBarOffset;
    }
    if (current.diffLayoutPreference !== previous.diffLayoutPreference) {
      diff.diffLayoutPreference = current.diffLayoutPreference;
    }
    if (current.diffViewMode !== previous.diffViewMode) {
      diff.diffViewMode = current.diffViewMode;
    }

    previous = current;

    if (Object.keys(diff).length > 0) {
      schedule(diff);
    }
  });
};
