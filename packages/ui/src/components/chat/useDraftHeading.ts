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

export function useDraftHeading(projectLabel: string | null, format: 'text' | 'template' = 'text'): string {
  const { t } = useI18n();
  const copy = useEasterEggCopy();
  const visit = useDraftVisit((state) => state.visit);
  const moment = useDraftVisit((state) => state.moment);
  const lead = useSessionUIStore((state) => state.newSessionDraft.lead === true);
  const params = projectLabel && format === 'text' ? { project: projectLabel } : undefined;
  if (lead) {
    return projectLabel
      ? t('chat.emptyState.leadDraftTitleWithProject', params)
      : t('chat.emptyState.leadDraftTitle');
  }
  if (!projectLabel) return t('chat.emptyState.draftTitle');
  const line = copy ? draftTitleLine(copy, moment, SEED + visit) : null;
  if (!line) return t('chat.emptyState.draftTitleWithProject', params);
  return format === 'template' ? line : line.replace('{project}', () => projectLabel);
}
