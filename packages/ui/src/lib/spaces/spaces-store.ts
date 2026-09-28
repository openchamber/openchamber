// What the UI knows about isolated spaces: the mark the global session list carries per space,
// kept for the sidebar and for the rules that depend on a space existing at all. Runtime-scoped:
// reset when the runtime endpoint changes, filled again by the next global list.

import React from 'react';
import { create } from 'zustand';
import { z } from 'zod';

import { listSpaces, type SpaceEntry, type SpaceFailure, type SpaceGrant } from './spaces-api';
import type { SpaceProgress } from '@/sync/event-pipeline';

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

export type SpaceAccessFailure = { provider: string; code: string; message: string };

/** The model access a creation in this window gives once the space is ready, while and after it does. */
type SpaceCreationAccess = { kind: 'giving' } | { kind: 'failed'; failures: readonly SpaceAccessFailure[] };

/** The actions on a space the user can take from its group, from soft to hard. */
export type SpaceAction = 'start' | 'stop' | 'restart_opencode' | 'restart' | 'remove';

/** An action this window started on a space: under way, or failed with the server's reason. */
export type SpaceActionState =
  | { kind: 'running'; action: SpaceAction }
  | { kind: 'failed'; action: SpaceAction; failure: SpaceFailure };

type SpacesState = {
  spaces: ReadonlyMap<string, SpaceMark>;
  /**
   * The journey route's list, the one source that knows a space still being made or one whose
   * making failed; null until it answered once for this runtime. The steps of a creation that
   * arrive as events after a read began win over that read's answer.
   */
  journey: ReadonlyMap<string, SpaceEntry> | null;
  /** Counts progress events, so a read can tell which of them it has not seen. */
  progressRevision: number;
  /** Replaces the journey entries with a complete list whose read began at `revision`. */
  applyJourney: (entries: readonly SpaceEntry[], revision: number) => void;
  /** A creation step announced by the host. Resolves whether the space was known to the list. */
  noteProgress: (progress: SpaceProgress) => boolean;
  /** A creation this window started, shown at once, before the next read of the list. */
  addJourneyEntry: (entry: SpaceEntry) => void;
  /**
   * The model access a creation in this window is giving or could not give, per space. Only this
   * window knows it: the host keeps no grant it could not deliver.
   */
  creationAccess: ReadonlyMap<string, SpaceCreationAccess>;
  noteCreationAccess: (spaceId: string, access: SpaceCreationAccess | null) => void;
  /** A provider the grant dialog gave: it no longer counts among the creation's failures. */
  noteProviderGranted: (spaceId: string, providerId: string) => void;
  /**
   * A grant the host just accepted, entered into the space's entry at once and counted like a
   * step, so a read of the list that began before it cannot take it away; the next read that
   * begins after it is the host's word again.
   */
  noteGrantGiven: (spaceId: string, grant: SpaceGrant) => void;
  /** The grant dialog, open on one space and, when opened for a missing key, on its provider. */
  accessDialog: { spaceId: string; providerId: string | null } | null;
  openAccessDialog: (spaceId: string, providerId?: string | null) => void;
  closeAccessDialog: () => void;
  /** The action under way or failed per space, in this window, for the group's status line and menu. */
  actions: ReadonlyMap<string, SpaceActionState>;
  noteAction: (spaceId: string, state: SpaceActionState | null) => void;
  /** The confirmation before a space is deleted, open on one space. */
  deleteDialog: string | null;
  openDeleteDialog: (spaceId: string) => void;
  closeDeleteDialog: () => void;
  /** The phone's sheet of a space's actions, where the desktop has the group's menu. */
  actionsSheet: string | null;
  openActionsSheet: (spaceId: string) => void;
  closeActionsSheet: () => void;
  /** Replaces the marks with those of a complete global list. */
  applyMarks: (marks: readonly SpaceMark[]) => void;
  /** The space's event connection came or went; a gap shows the space as stale until the next list. */
  noteStream: (spaceId: string, status: 'connected' | 'disconnected') => void;
  /** A per-directory read of the space answered, so it is reachable again. */
  noteReachable: (spaceId: string) => void;
  resetForRuntimeSwitch: () => void;
  /** The feature was turned off here: none of its spaces is reachable until it is on again. */
  forgetForSwitchOff: () => void;
};

const EMPTY: ReadonlyMap<string, SpaceMark> = new Map();

// Which space each progress event touched, by the revision it arrived at; a list whose read began
// earlier keeps the step the event gave rather than its own older view.
const progressAt = new Map<string, number>();

const withProgress = (entry: SpaceEntry, progress: SpaceProgress): SpaceEntry => (progress.step === 'failed'
  ? { ...entry, state: 'failed', failure: progress.failure }
  : { ...entry, state: progress.step === 'ready' ? 'running' : 'preparing', step: progress.step === 'ready' ? null : progress.step, failure: null });

const withState = (spaces: ReadonlyMap<string, SpaceMark>, spaceId: string, state: SpaceListState): ReadonlyMap<string, SpaceMark> => {
  const current = spaces.get(spaceId);
  if (!current || current.state === state) return spaces;
  const next = new Map(spaces);
  next.set(spaceId, { ...current, state });
  return next;
};

export const useSpacesStore = create<SpacesState>((set, get) => ({
  spaces: EMPTY,
  journey: null,
  progressRevision: 0,
  applyJourney: (entries, revision) => set((current) => {
    const next = new Map(entries.map((entry) => [entry.id, entry]));
    for (const [spaceId, at] of progressAt) {
      const newer = current.journey?.get(spaceId);
      if (at > revision && newer) next.set(spaceId, newer);
    }
    return { journey: next };
  }),
  addJourneyEntry: (entry) => set((current) => {
    // Counted like a step, so a read that began before the creation does not drop it.
    const progressRevision = current.progressRevision + 1;
    progressAt.set(entry.id, progressRevision);
    const journey = new Map(current.journey ?? []);
    journey.set(entry.id, entry);
    return { journey, progressRevision };
  }),
  creationAccess: new Map(),
  noteCreationAccess: (spaceId, access) => set((current) => {
    const creationAccess = new Map(current.creationAccess);
    if (access) creationAccess.set(spaceId, access);
    else creationAccess.delete(spaceId);
    return { creationAccess };
  }),
  noteProviderGranted: (spaceId, providerId) => set((current) => {
    const access = current.creationAccess.get(spaceId);
    if (access?.kind !== 'failed') return current;
    const failures = access.failures.filter((failure) => failure.provider !== providerId);
    const creationAccess = new Map(current.creationAccess);
    if (failures.length > 0) creationAccess.set(spaceId, { kind: 'failed', failures });
    else creationAccess.delete(spaceId);
    return { creationAccess };
  }),
  noteGrantGiven: (spaceId, grant) => set((current) => {
    const entry = current.journey?.get(spaceId);
    if (!entry) return current;
    const progressRevision = current.progressRevision + 1;
    progressAt.set(spaceId, progressRevision);
    const journey = new Map(current.journey);
    journey.set(spaceId, {
      ...entry,
      grants: [...entry.grants.filter((known) => known.id !== grant.id), grant],
      needsAccess: entry.needsAccess.filter((id) => id !== grant.id),
    });
    return { journey, progressRevision };
  }),
  accessDialog: null,
  openAccessDialog: (spaceId, providerId = null) => set({ accessDialog: { spaceId, providerId } }),
  closeAccessDialog: () => set({ accessDialog: null }),
  actions: new Map(),
  noteAction: (spaceId, state) => set((current) => {
    const actions = new Map(current.actions);
    if (state) actions.set(spaceId, state);
    else actions.delete(spaceId);
    return { actions };
  }),
  deleteDialog: null,
  openDeleteDialog: (spaceId) => set({ deleteDialog: spaceId }),
  closeDeleteDialog: () => set({ deleteDialog: null }),
  actionsSheet: null,
  openActionsSheet: (spaceId) => set({ actionsSheet: spaceId }),
  closeActionsSheet: () => set({ actionsSheet: null }),
  noteProgress: (progress) => {
    const revision = get().progressRevision + 1;
    progressAt.set(progress.spaceId, revision);
    const entry = get().journey?.get(progress.spaceId);
    if (!entry) {
      set({ progressRevision: revision });
      return false;
    }
    const journey = new Map(get().journey);
    journey.set(progress.spaceId, withProgress(entry, progress));
    set({ journey, progressRevision: revision });
    return true;
  },
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
  resetForRuntimeSwitch: () => {
    progressAt.clear();
    journeyGeneration += 1;
    set({ spaces: EMPTY, journey: null, progressRevision: 0, creationAccess: new Map(), accessDialog: null, actions: new Map(), deleteDialog: null, actionsSheet: null });
  },
  forgetForSwitchOff: () => get().resetForRuntimeSwitch(),
}));

let journeyGeneration = 0;

/** Counts runtime switches, so work started before one can tell that its answer is no longer wanted. */
export const spacesRuntimeGeneration = (): number => journeyGeneration;

/**
 * Reads the journey list again and keeps it. A read that fails leaves the last list in place and
 * rejects, so a failure never reads as "no spaces"; one that a runtime switch overtook is dropped.
 */
export const refreshSpacesJourney = async (): Promise<void> => {
  const generation = journeyGeneration;
  const revision = useSpacesStore.getState().progressRevision;
  const entries = await listSpaces();
  if (generation !== journeyGeneration) return;
  useSpacesStore.getState().applyJourney(entries, revision);
};

/** Whether this runtime has any isolated space at all, reachable or not. */
export const hasIsolatedSpaces = (): boolean => useSpacesStore.getState().spaces.size > 0;

export const getSpaceMark = (spaceId: string): SpaceMark | null => useSpacesStore.getState().spaces.get(spaceId) ?? null;

/**
 * The spaces the sidebar shows a group for: every space the session list marked, and the ones
 * only the journey list knows, a space being made or whose making failed among them, so its group
 * appears the moment it exists. A journey-only space has no session list yet, so it is not stale.
 */
const mergeSidebarSpaces = (marks: ReadonlyMap<string, SpaceMark>, journey: ReadonlyMap<string, SpaceEntry> | null): SpaceMark[] => {
  const merged = Array.from(marks.values());
  for (const entry of journey?.values() ?? []) {
    if (marks.has(entry.id) || entry.projectDirectory === null || entry.directory === null) continue;
    merged.push({ id: entry.id, name: entry.name, state: 'complete', projectDirectory: entry.projectDirectory, directory: entry.directory });
  }
  return merged;
};

export const useSidebarSpaces = (): SpaceMark[] => {
  const marks = useSpacesStore((state) => state.spaces);
  const journey = useSpacesStore((state) => state.journey);
  return React.useMemo(() => mergeSidebarSpaces(marks, journey), [journey, marks]);
};
