import type { I18nKey } from '@/lib/i18n';

/** The sentences a tracker's Settings card shows. */
type TrackerSettingsCopy = {
  description: I18nKey;
  connected: I18nKey;
  notConnected: I18nKey;
  waiting: I18nKey;
  connect: I18nKey;
  disconnect: I18nKey;
  addAccount: I18nKey;
  switchTo: I18nKey;
  otherAccounts: I18nKey;
  flowDescription: I18nKey;
  flowWaiting: I18nKey;
  toastConnected: I18nKey;
  toastDisconnected: I18nKey;
  toastAccountSwitched: I18nKey;
  toastAccountSwitchFailed: I18nKey;
  toastStartConnectFailed: I18nKey;
  toastDisconnectFailed: I18nKey;
  toastAuthorizationFailed: I18nKey;
  avatarAlt: I18nKey;
  unknownUser: I18nKey;
  unsupportedSignIn: I18nKey;
  mapping: {
    defaultProject: I18nKey;
    defaultProjectInfo: I18nKey;
    defaultProjectNone: I18nKey;
    defaultProjectAria: I18nKey;
    containers: I18nKey;
    containersInfo: I18nKey;
    containerUseDefault: I18nKey;
    containerAria: I18nKey;
    emptyProjects: I18nKey;
    emptyContainers: I18nKey;
    loadFailed: I18nKey;
  };
  sessionComments: {
    label: I18nKey;
    info: I18nKey;
    aria: I18nKey;
    loadFailed: I18nKey;
  };
};

// Sentences that name only the tracker take `{provider}`; callers pass the
// tracker's name. A tracker without an entry of its own reads these.
const GENERIC_COPY: TrackerSettingsCopy = {
  description: 'settings.integrations.tracker.description',
  connected: 'settings.integrations.tracker.status.connected',
  notConnected: 'settings.integrations.tracker.status.notConnected',
  waiting: 'settings.integrations.tracker.status.waiting',
  connect: 'settings.integrations.tracker.actions.connect',
  disconnect: 'settings.integrations.tracker.actions.disconnect',
  addAccount: 'settings.integrations.tracker.actions.addAccount',
  switchTo: 'settings.integrations.tracker.actions.switchTo',
  otherAccounts: 'settings.integrations.tracker.label.otherAccounts',
  flowDescription: 'settings.integrations.tracker.flow.description',
  flowWaiting: 'settings.integrations.tracker.flow.waiting',
  toastConnected: 'settings.integrations.tracker.toast.connected',
  toastDisconnected: 'settings.integrations.tracker.toast.disconnected',
  toastAccountSwitched: 'settings.integrations.tracker.toast.accountSwitched',
  toastAccountSwitchFailed: 'settings.integrations.tracker.toast.accountSwitchFailed',
  toastStartConnectFailed: 'settings.integrations.tracker.toast.startConnectFailed',
  toastDisconnectFailed: 'settings.integrations.tracker.toast.disconnectFailed',
  toastAuthorizationFailed: 'settings.integrations.tracker.toast.authorizationFailed',
  avatarAlt: 'settings.integrations.tracker.avatarAlt',
  unknownUser: 'settings.integrations.tracker.unknownUser',
  unsupportedSignIn: 'settings.integrations.tracker.updateApp',
  mapping: {
    defaultProject: 'settings.integrations.tracker.mapping.defaultProject',
    defaultProjectInfo: 'settings.integrations.tracker.mapping.defaultProject.info',
    defaultProjectNone: 'settings.integrations.tracker.mapping.defaultProject.none',
    defaultProjectAria: 'settings.integrations.tracker.mapping.defaultProject.aria',
    containers: 'settings.integrations.tracker.mapping.containers',
    containersInfo: 'settings.integrations.tracker.mapping.containers.info',
    containerUseDefault: 'settings.integrations.tracker.mapping.containers.useDefault',
    containerAria: 'settings.integrations.tracker.mapping.containers.aria',
    emptyProjects: 'settings.integrations.tracker.mapping.emptyProjects',
    emptyContainers: 'settings.integrations.tracker.mapping.emptyContainers',
    loadFailed: 'settings.integrations.tracker.mapping.loadFailed',
  },
  sessionComments: {
    label: 'settings.integrations.tracker.sessionComments.label',
    info: 'settings.integrations.tracker.sessionComments.info',
    aria: 'settings.integrations.tracker.sessionComments.aria',
    loadFailed: 'settings.integrations.tracker.sessionComments.loadFailed',
  },
};

// Linear's own nouns (workspace, team) cannot be interpolated without breaking
// case and gender in de, pl, uk and fr, so its sentences that carry them stay
// whole per tracker.
const LINEAR_COPY: TrackerSettingsCopy = {
  ...GENERIC_COPY,
  description: 'settings.integrations.linear.description',
  addAccount: 'settings.integrations.linear.actions.addWorkspace',
  otherAccounts: 'settings.integrations.linear.label.otherWorkspaces',
  toastAccountSwitched: 'settings.integrations.linear.toast.workspaceSwitched',
  toastAccountSwitchFailed: 'settings.integrations.linear.toast.workspaceSwitchFailed',
  mapping: {
    ...GENERIC_COPY.mapping,
    defaultProjectInfo: 'settings.integrations.linear.mapping.defaultProject.info',
    containers: 'settings.integrations.linear.mapping.teams',
    containersInfo: 'settings.integrations.linear.mapping.teams.info',
    containerAria: 'settings.integrations.linear.mapping.teams.aria',
    emptyProjects: 'settings.integrations.linear.mapping.emptyProjects',
    emptyContainers: 'settings.integrations.linear.mapping.emptyTeams',
  },
};

const COPY_BY_TRACKER = new Map<string, TrackerSettingsCopy>([['linear', LINEAR_COPY]]);

/** The Settings sentences of a tracker, by its id; a tracker without its own reads the generic ones. */
export const trackerSettingsCopy = (id: string): TrackerSettingsCopy => COPY_BY_TRACKER.get(id) ?? GENERIC_COPY;
