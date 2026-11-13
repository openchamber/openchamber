import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

/**
 * What the UI adds to a served tracker descriptor: its mark and the sentences
 * that name it. Translated text cannot come from the server, so it lives here
 * per id, with a generic fallback for a tracker this version does not know.
 */
type TrackerPresentation = {
  icon: IconName;
  copy: TrackerCopyKeys;
  /** The branch prefix a worktree started from an item gets; the dialog appends `-<slug>`. */
  branchName: (item: { identifier: string }) => string;
  /** What Settings search finds for the tracker; a tracker without its own words has no entries. */
  settingsSearch?: TrackerSettingsSearch;
};

type TrackerSettingsSearch = {
  title: I18nKey;
  description: I18nKey;
  keywords: string[];
  /** Offered where the tracker connects several accounts. */
  addAccount: { title: I18nKey; keywords: string[] };
  /** Offered where the tracker maps containers to projects. */
  mapping: { title: I18nKey; description: I18nKey; keywords: string[] };
};

/**
 * Sentences that carry the tracker's own nouns (workspace, team), which cannot
 * be interpolated without breaking case and gender in de, pl, uk and fr.
 * Sentences that only name the tracker use the `{provider}` keys directly.
 */
type TrackerCopyKeys = {
  accountSwitched: I18nKey;
  accountSwitchFailed: I18nKey;
  /** Board scope picker: "Linear team", "All teams", "Linear workspace". */
  containerLabel: I18nKey;
  containerAll: I18nKey;
  accountLabel: I18nKey;
  /** Preview meta row naming the item's container: "Team". */
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

// Branches started from an item read `issue-ENG-12-<slug>`; existing branches keep matching.
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
