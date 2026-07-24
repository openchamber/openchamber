import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings } from '@/lib/desktop';
import type { ReasoningMode, TerminalShell } from '@/lib/api/types';
import type { MonoFontOption, UiFontOption } from '@/lib/fontOptions';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';

type AppearanceSlice = {
  reasoningMode: ReasoningMode;
  sessionRecapEnabled: boolean;
  sessionSuggestionEnabled: boolean;
  sessionGoalEnabled: boolean;
  sessionGoalDefaultBudgetEnabled: boolean;
  sessionGoalDefaultBudget: number;
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
  sessionRetentionAction: 'archive' | 'delete';
  fontSize: number;
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
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode: 'flat' | 'tree';
};

let initialized = false;

export const startAppearanceAutoSave = (): void => {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  initialized = true;

  let previous: AppearanceSlice = {
    reasoningMode: useUIStore.getState().reasoningMode,
    sessionRecapEnabled: useUIStore.getState().sessionRecapEnabled,
    sessionSuggestionEnabled: useUIStore.getState().sessionSuggestionEnabled,
    sessionGoalEnabled: useUIStore.getState().sessionGoalEnabled,
    sessionGoalDefaultBudgetEnabled: useUIStore.getState().sessionGoalDefaultBudgetEnabled,
    sessionGoalDefaultBudget: useUIStore.getState().sessionGoalDefaultBudget,
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
    sessionRetentionAction: useUIStore.getState().sessionRetentionAction,
    fontSize: useUIStore.getState().fontSize,
    terminalFontSize: useUIStore.getState().terminalFontSize,
    terminalShell: useUIStore.getState().terminalShell,
    terminalLoginShells: useUIStore.getState().terminalLoginShells,
    editorFontSize: useUIStore.getState().editorFontSize,
    uiFont: useUIStore.getState().uiFont,
    monoFont: useUIStore.getState().monoFont,
    padding: useUIStore.getState().padding,
    cornerRadius: useUIStore.getState().cornerRadius,
    inputBarOffset: useUIStore.getState().inputBarOffset,
    mobileKeyboardMode: useUIStore.getState().mobileKeyboardMode,
    diffLayoutPreference: useUIStore.getState().diffLayoutPreference,
    gitChangesViewMode: useUIStore.getState().gitChangesViewMode,
  };

  useUIStore.subscribe((state) => {
    const current: AppearanceSlice = {
      reasoningMode: state.reasoningMode,
      sessionRecapEnabled: state.sessionRecapEnabled,
      sessionSuggestionEnabled: state.sessionSuggestionEnabled,
      sessionGoalEnabled: state.sessionGoalEnabled,
      sessionGoalDefaultBudgetEnabled: state.sessionGoalDefaultBudgetEnabled,
      sessionGoalDefaultBudget: state.sessionGoalDefaultBudget,
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
      sessionRetentionAction: state.sessionRetentionAction,
      fontSize: state.fontSize,
      terminalFontSize: state.terminalFontSize,
      terminalShell: state.terminalShell,
      terminalLoginShells: state.terminalLoginShells,
      editorFontSize: state.editorFontSize,
      uiFont: state.uiFont,
      monoFont: state.monoFont,
      padding: state.padding,
      cornerRadius: state.cornerRadius,
      inputBarOffset: state.inputBarOffset,
      mobileKeyboardMode: state.mobileKeyboardMode,
      diffLayoutPreference: state.diffLayoutPreference,
      gitChangesViewMode: state.gitChangesViewMode,
    };

    const diff: Partial<DesktopSettings> = {};

    if (current.reasoningMode !== previous.reasoningMode) {
      diff.reasoningMode = current.reasoningMode;
    }
    if (current.sessionRecapEnabled !== previous.sessionRecapEnabled) {
      diff.sessionRecapEnabled = current.sessionRecapEnabled;
    }
    if (current.sessionSuggestionEnabled !== previous.sessionSuggestionEnabled) {
      diff.sessionSuggestionEnabled = current.sessionSuggestionEnabled;
    }
    if (current.sessionGoalEnabled !== previous.sessionGoalEnabled) {
      diff.sessionGoalEnabled = current.sessionGoalEnabled;
    }
    if (current.sessionGoalDefaultBudgetEnabled !== previous.sessionGoalDefaultBudgetEnabled) {
      diff.sessionGoalDefaultBudgetEnabled = current.sessionGoalDefaultBudgetEnabled;
    }
    if (current.sessionGoalDefaultBudget !== previous.sessionGoalDefaultBudget) {
      diff.sessionGoalDefaultBudget = current.sessionGoalDefaultBudget;
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
    if (current.sessionRetentionAction !== previous.sessionRetentionAction) {
      diff.sessionRetentionAction = current.sessionRetentionAction;
    }
    if (current.fontSize !== previous.fontSize) {
      diff.fontSize = current.fontSize;
    }
    if (current.terminalFontSize !== previous.terminalFontSize) {
      diff.terminalFontSize = current.terminalFontSize;
    }
    if (current.terminalShell !== previous.terminalShell) {
      diff.terminalShell = current.terminalShell;
    }
    if (current.terminalLoginShells !== previous.terminalLoginShells) {
      diff.terminalLoginShells = current.terminalLoginShells;
    }
    if (current.editorFontSize !== previous.editorFontSize) {
      diff.editorFontSize = current.editorFontSize;
    }
    if (current.uiFont !== previous.uiFont) {
      diff.uiFont = current.uiFont;
    }
    if (current.monoFont !== previous.monoFont) {
      diff.monoFont = current.monoFont;
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
    if (current.mobileKeyboardMode !== previous.mobileKeyboardMode) {
      diff.mobileKeyboardMode = current.mobileKeyboardMode;
    }
    if (current.diffLayoutPreference !== previous.diffLayoutPreference) {
      diff.diffLayoutPreference = current.diffLayoutPreference;
    }
    if (current.gitChangesViewMode !== previous.gitChangesViewMode) {
      diff.gitChangesViewMode = current.gitChangesViewMode;
    }

    previous = current;

    if (Object.keys(diff).length > 0) {
      void updateDesktopSettings(diff);
    }
  });

};
