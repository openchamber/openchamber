import { create } from 'zustand';

import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { draftMomentAt, draftTitleLine, type DraftMoment } from '@/lib/easter-eggs/lines';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';

// One pick per visit to the new-session screen. The welcome heading and the
// composer heading show the same line, and the line stays while the screen
// does, including when a saved draft is picked from the drafts menu (that
// opens a new draft id without leaving the screen). Leaving for a session and
// coming back takes the next line. The seed keeps the first visit after
// launch from always opening on the same one.
const SEED = Math.floor(Math.random() * 1000);

// A store, not a module variable: the compiled hook memoizes on what it reads.
const useDraftVisit = create<{ visit: number; moment: DraftMoment }>(() => ({
  visit: 0,
  moment: draftMomentAt(new Date()),
}));

useSessionUIStore.subscribe((state, previous) => {
  if (!state.newSessionDraft.open || previous.newSessionDraft.open) return;
  useDraftVisit.setState(({ visit }) => ({ visit: visit + 1, moment: draftMomentAt(new Date()) }));
});

/** The new-session heading: a rotating line when the draft has a project, the plain question otherwise. */
export function useDraftHeading(projectLabel: string | null): string {
  const { t } = useI18n();
  const copy = useEasterEggCopy();
  const visit = useDraftVisit((state) => state.visit);
  const moment = useDraftVisit((state) => state.moment);
  if (!projectLabel) return t('chat.emptyState.draftTitle');
  const line = copy ? draftTitleLine(copy, moment, SEED + visit) : null;
  return line
    // A function replacement: a project named `$&` must stay literal.
    ? line.replace('{project}', () => projectLabel)
    : t('chat.emptyState.draftTitleWithProject', { project: projectLabel });
}
