// What the UI knows about isolated spaces: the mark the global session list carries per space,
// kept for the sidebar and for the rules that depend on a space existing at all. Runtime-scoped:
// reset when the runtime endpoint changes, filled again by the next global list.

import { create } from 'zustand';
import { z } from 'zod';

/**
 * How the last answer of a space stood when the host merged the list: `complete`, `partial`
 * when the space had more pages than the host read, `stale` when its last known list stands in
 * for an answer that did not come, `unknown` when it never answered and has no records.
 */
export type SpaceListState = 'complete' | 'partial' | 'stale' | 'unknown';

export type SpaceMark = {
  id: string;
  name: string;
  state: SpaceListState;
  /** The registered host project the space was made for, or null when the host no longer has it. */
  projectDirectory: string | null;
  /** The project's path inside the space, or null with `projectDirectory`. */
  directory: string | null;
};

export const spaceMarkSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string().default(''),
  state: z.enum(['complete', 'partial', 'stale', 'unknown']),
  projectDirectory: z.string().nullable().default(null),
  directory: z.string().nullable().default(null),
});

type SpacesState = {
  spaces: ReadonlyMap<string, SpaceMark>;
  /** Replaces the marks with those of a complete global list. */
  applyMarks: (marks: readonly SpaceMark[]) => void;
  /** The space's event connection came or went; a gap shows the space as stale until the next list. */
  noteStream: (spaceId: string, status: 'connected' | 'disconnected') => void;
  /** A per-directory read of the space answered, so it is reachable again. */
  noteReachable: (spaceId: string) => void;
  resetForRuntimeSwitch: () => void;
};

const EMPTY: ReadonlyMap<string, SpaceMark> = new Map();

const withState = (spaces: ReadonlyMap<string, SpaceMark>, spaceId: string, state: SpaceListState): ReadonlyMap<string, SpaceMark> => {
  const current = spaces.get(spaceId);
  if (!current || current.state === state) return spaces;
  const next = new Map(spaces);
  next.set(spaceId, { ...current, state });
  return next;
};

export const useSpacesStore = create<SpacesState>((set) => ({
  spaces: EMPTY,
  applyMarks: (marks) => set((current) => {
    const next = new Map(marks.map((mark) => [mark.id, mark]));
    if (next.size === 0 && current.spaces.size === 0) return current;
    return { spaces: next };
  }),
  noteStream: (spaceId, status) => set((current) => {
    // A connection that is back says nothing about the list; the read that follows does.
    if (status === 'connected') return current;
    return { spaces: withState(current.spaces, spaceId, 'stale') };
  }),
  noteReachable: (spaceId) => set((current) => ({ spaces: withState(current.spaces, spaceId, 'complete') })),
  resetForRuntimeSwitch: () => set({ spaces: EMPTY }),
}));

/** Whether this runtime has any isolated space at all, reachable or not. */
export const hasIsolatedSpaces = (): boolean => useSpacesStore.getState().spaces.size > 0;

export const getSpaceMark = (spaceId: string): SpaceMark | null => useSpacesStore.getState().spaces.get(spaceId) ?? null;
