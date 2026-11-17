import { create } from 'zustand';

import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { draftMomentAt, draftTitleLine, type DraftMoment } from '@/lib/easter-eggs/lines';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';

const SEED = Math.floor(Math.random() * 1000);

const useDraftVisit = create<{ visit: number; moment: DraftMoment }>(() => ({
  visit: 0,
  moment: draftMomentAt(new Date()),
}));

useSessionUIStore.subscribe((state, previous) => {
  if (!state.newSessionDraft.open || previous.newSessionDraft.open) return;
  useDraftVisit.setState(({ visit }) => ({ visit: visit + 1, moment: draftMomentAt(new Date()) }));
});

export function useDraftHeading(projectLabel: string | null): string {
  const { t } = useI18n();
  const copy = useEasterEggCopy();
  const visit = useDraftVisit((state) => state.visit);
  const moment = useDraftVisit((state) => state.moment);
  if (!projectLabel) return t('chat.emptyState.draftTitle');
  const line = copy ? draftTitleLine(copy, moment, SEED + visit) : null;
  return line
    ? line.replace('{project}', () => projectLabel)
    : t('chat.emptyState.draftTitleWithProject', { project: projectLabel });
}
