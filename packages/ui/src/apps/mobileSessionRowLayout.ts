import type { SessionRowDisplay, SessionRowLines } from '@/stores/useSessionDisplayStore';

export type MobileSessionRowKind = 'chats' | 'project' | 'other';

type RowLinePreferences = Pick<SessionRowDisplay, 'chatsLines' | 'projectLines'>;

export const mobileSessionRowLinesFor = (
  kind: MobileSessionRowKind,
  preferences: RowLinePreferences,
): SessionRowLines => {
  if (kind === 'chats') return preferences.chatsLines;
  if (kind === 'project') return preferences.projectLines;
  return 'one';
};

export const mobileSessionRowHeightClass = (rowLines: SessionRowLines, hasContextLabel: boolean): string => {
  if (rowLines === 'two') return 'min-h-[52px] py-1';
  return hasContextLabel ? 'min-h-10 py-1' : 'h-9';
};
