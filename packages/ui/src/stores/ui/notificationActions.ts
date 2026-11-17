import type { UIStoreSlice } from './types';

export const createNotificationActions: UIStoreSlice<
  | 'setNativeNotificationsEnabled'
  | 'setNotificationMode'
  | 'setNotifyOnSubtasks'
  | 'setDockBadgeEnabled'
  | 'setNotifyOnCompletion'
  | 'setNotifyOnPullRequests'
  | 'setNotifyOnError'
  | 'setNotifyOnQuestion'
  | 'setNotificationTemplates'
  | 'setSummarizeLastMessage'
  | 'setSummaryThreshold'
  | 'setSummaryLength'
  | 'setMaxLastMessageLength'
> = (set) => ({
  setNativeNotificationsEnabled: (value) => {
    set({ nativeNotificationsEnabled: value });
  },

  setNotificationMode: (mode) => {
    set({ notificationMode: mode });
  },

  setNotifyOnSubtasks: (value) => {
    set({ notifyOnSubtasks: value });
  },

  setDockBadgeEnabled: (value) => {
    set({ dockBadgeEnabled: value });
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
});
