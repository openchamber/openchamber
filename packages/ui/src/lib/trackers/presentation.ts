import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

type TrackerPresentation = {
  icon: IconName;
  copy: TrackerCopyKeys;
  branchName: (item: { identifier: string }) => string;
  settingsSearch?: TrackerSettingsSearch;
};

type TrackerSettingsSearch = {
  title: I18nKey;
  description: I18nKey;
  keywords: string[];
  addAccount: { title: I18nKey; keywords: string[] };
  mapping: { title: I18nKey; description: I18nKey; keywords: string[] };
};

type TrackerCopyKeys = {
  accountSwitched: I18nKey;
  accountSwitchFailed: I18nKey;
  containerLabel: I18nKey;
  containerAll: I18nKey;
  accountLabel: I18nKey;
  containerMeta: I18nKey;
};

const LINEAR_COPY: TrackerCopyKeys = {
  accountSwitched: 'settings.integrations.linear.toast.workspaceSwitched',
  accountSwitchFailed: 'settings.integrations.linear.toast.workspaceSwitchFailed',
  containerLabel: 'sourceBoard.team.label',
  containerAll: 'sourceBoard.team.all',
  accountLabel: 'sourceBoard.workspace.label',
  containerMeta: 'references.picker.preview.team',
};

const GENERIC_COPY: TrackerCopyKeys = {
  accountSwitched: 'settings.integrations.tracker.toast.accountSwitched',
  accountSwitchFailed: 'settings.integrations.tracker.toast.accountSwitchFailed',
  containerLabel: 'sourceBoard.tracker.container.label',
  containerAll: 'sourceBoard.tracker.container.all',
  accountLabel: 'sourceBoard.tracker.account.label',
  containerMeta: 'references.picker.preview.container',
};

const issueBranchName = (item: { identifier: string }): string => `issue-${item.identifier}`;

const LINEAR_SETTINGS_SEARCH: TrackerSettingsSearch = {
  title: 'settings.integrations.linear.title',
  description: 'settings.integrations.linear.description',
  keywords: ['linear', 'issues', 'oauth', 'connect', 'workspace'],
  addAccount: { title: 'settings.integrations.linear.actions.addWorkspace', keywords: ['linear', 'workspace', 'add', 'connect', 'oauth'] },
  mapping: {
    title: 'settings.integrations.tracker.mapping.defaultProject',
    description: 'settings.integrations.linear.mapping.defaultProject.info',
    keywords: ['linear', 'project', 'team', 'map', 'workspace', 'directory'],
  },
};

const PRESENTATIONS = new Map<string, TrackerPresentation>([
  ['linear', { icon: 'linear', copy: LINEAR_COPY, branchName: issueBranchName, settingsSearch: LINEAR_SETTINGS_SEARCH }],
]);

const GENERIC_PRESENTATION: TrackerPresentation = { icon: 'record-circle', copy: GENERIC_COPY, branchName: issueBranchName };

export const trackerPresentation = (id: string | null | undefined): TrackerPresentation => (
  (id ? PRESENTATIONS.get(id) : undefined) ?? GENERIC_PRESENTATION
);
