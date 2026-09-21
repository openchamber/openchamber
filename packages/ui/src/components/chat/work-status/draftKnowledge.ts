import type { SessionKnowledgeSummary, SessionProjectContextPins } from '@/lib/sessionKnowledgeApi';

type NoteSource = { id: string; body: string };
type PlanSource = { id: string; title: string };

export const resolveDraftPinnedKnowledge = (
  notes: NoteSource[],
  plans: PlanSource[],
  pins: SessionProjectContextPins,
): Pick<SessionKnowledgeSummary, 'notes' | 'plans'> => {
  const noteIds = new Set(pins.notes);
  const planIds = new Set(pins.plans);
  return {
    notes: notes.filter((note) => noteIds.has(note.id)).map(({ id, body }) => ({ id, body })),
    plans: plans.filter((plan) => planIds.has(plan.id)).map(({ id, title }) => ({ id, title })),
  };
};
