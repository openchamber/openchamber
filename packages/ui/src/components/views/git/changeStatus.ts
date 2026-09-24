import type { GitStatus } from '@/lib/api/types';
import type { I18nKey } from '@/lib/i18n';

type StatusFile = GitStatus['files'][number];

type ChangeDescriptor = {
  code: string;
  color: string;
  descriptionKey: I18nKey;
};

const MODIFIED_DESCRIPTOR: ChangeDescriptor = {
  code: 'M',
  color: 'var(--status-warning)',
  descriptionKey: 'diffView.change.modified',
};

const CONFLICT_DESCRIPTOR: ChangeDescriptor = {
  code: '!',
  color: 'var(--status-error)',
  descriptionKey: 'diffView.change.conflicted',
};

const CHANGE_DESCRIPTORS = new Map<string, ChangeDescriptor>([
  ['?', { code: '?', color: 'var(--status-info)', descriptionKey: 'diffView.change.untracked' }],
  ['A', { code: 'A', color: 'var(--status-success)', descriptionKey: 'diffView.change.new' }],
  ['D', { code: 'D', color: 'var(--status-error)', descriptionKey: 'diffView.change.deleted' }],
  ['R', { code: 'R', color: 'var(--status-info)', descriptionKey: 'diffView.change.renamed' }],
  ['C', { code: 'C', color: 'var(--status-info)', descriptionKey: 'diffView.change.copied' }],
  ['M', MODIFIED_DESCRIPTOR],
]);

/** Porcelain marks one-sided conflicts with U and both-sided ones as AA or DD. */
export const isConflictedStatusFile = (file: StatusFile): boolean => {
  const index = file.index?.trim() ?? '';
  const working = file.working_dir?.trim() ?? '';
  return index === 'U' || working === 'U' || (index === 'A' && working === 'A') || (index === 'D' && working === 'D');
};

const isUntrackedStatusFile = (file: StatusFile): boolean =>
  file.index?.trim() === '?' || file.working_dir?.trim() === '?';

/** `git pull --rebase` refuses to start over changes to tracked files only. */
export const hasUncommittedTrackedChanges = (files: StatusFile[] | undefined): boolean =>
  (files ?? []).some((file) => !isUntrackedStatusFile(file));

const getChangeSymbol = (file: StatusFile): string => {
  const indexCode = file.index?.trim();
  const workingCode = file.working_dir?.trim();

  if (indexCode && indexCode !== '?') return indexCode.charAt(0);
  if (workingCode) return workingCode.charAt(0);

  return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
};

export const describeChange = (file: StatusFile): ChangeDescriptor => {
  if (isConflictedStatusFile(file)) return CONFLICT_DESCRIPTOR;
  return CHANGE_DESCRIPTORS.get(getChangeSymbol(file)) ?? MODIFIED_DESCRIPTOR;
};
