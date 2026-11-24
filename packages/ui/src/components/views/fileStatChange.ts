export type FileStatSnapshot = {
  path: string;
  size: number;
  mtimeMs?: number;
};

type FileStatChangeInput = {
  size: number;
  mtimeMs?: number;
};

type FileStatAnswer = {
  path: string;
  size: number;
  mtimeMs?: number;
};

export const fileStatSnapshotForRequestedPath = (
  requestedPath: string,
  answer: FileStatAnswer,
): FileStatSnapshot => ({
  path: requestedPath,
  size: answer.size,
  mtimeMs: answer.mtimeMs,
});

const MIN_MTIME_CHANGE_MS = 1;

type OpenFilePollInput = {
  stat: 'found' | 'missing' | 'failed';
  showsFailure: boolean;
  sawMissing: boolean;
  hasUnsavedChanges: boolean;
  moving: boolean;
};

export const openFilePollStep = ({
  stat,
  showsFailure,
  sawMissing,
  hasUnsavedChanges,
  moving,
}: OpenFilePollInput): 'check-changes' | 'show-missing' | 'reload' | 'none' => {
  if (stat === 'missing') return hasUnsavedChanges || moving ? 'none' : 'show-missing';
  if (stat === 'failed') return 'none';
  if (!showsFailure) return 'check-changes';
  return sawMissing ? 'reload' : 'none';
};

export const hasFileStatChanged = (
  previous: FileStatChangeInput,
  latest: FileStatChangeInput,
): boolean => latest.size !== previous.size || (
  latest.mtimeMs !== undefined
  && previous.mtimeMs !== undefined
  && Math.abs(latest.mtimeMs - previous.mtimeMs) >= MIN_MTIME_CHANGE_MS
);
