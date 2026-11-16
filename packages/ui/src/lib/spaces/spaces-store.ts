
import React from 'react';
import { create } from 'zustand';
import { z } from 'zod';

import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { listSpaces, readSpaceCatalogProviders, readSpaceCustomProviders, spaceTaskTitleSchema, type SpaceTaskTitle, type SpaceCatalogProvider, type SpaceCustomProvider, type SpaceEntry, type SpaceFailure, type SpaceGrant } from './spaces-api';
import { spaceIdOfDirectory } from './space-route';
import { normalizePath } from '@/lib/pathNormalization';
import type { SpaceProgress } from '@/sync/event-pipeline';

export type SpaceListState = 'complete' | 'partial' | 'stale' | 'unknown';

export type SpaceMark = {
  id: string;
  name: string;
  taskTitle?: SpaceTaskTitle | null;
  state: SpaceListState;
  projectDirectory: string | null;
  directory: string | null;
};

export const spaceMarkSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string().default(''),
  taskTitle: spaceTaskTitleSchema.nullish(),
  state: z.enum(['complete', 'partial', 'stale', 'unknown']),
  projectDirectory: z.string().nullable().default(null),
  directory: z.string().nullable().default(null),
});

export type SpaceAction = 'start' | 'stop' | 'restart_opencode' | 'restart' | 'setup' | 'remove';

export type SpaceUnsavedChats = { tooLarge: readonly string[]; failed: number };

export type SpaceActionState =
  | { kind: 'running'; action: SpaceAction }
  | { kind: 'failed'; action: SpaceAction; failure: SpaceFailure };

type SpacesState = {
  spaces: ReadonlyMap<string, SpaceMark>;
  journey: ReadonlyMap<string, SpaceEntry> | null;
  progressRevision: number;
  applyJourney: (entries: readonly SpaceEntry[], revision: number) => void;
  noteProgress: (progress: SpaceProgress) => boolean;
  noteTaskTitle: (spaceId: string, taskTitle: SpaceTaskTitle | null) => boolean;
  addJourneyEntry: (entry: SpaceEntry) => void;
  noteGrantGiven: (spaceId: string, grant: SpaceGrant) => void;
  customProviders: ReadonlyMap<string, readonly SpaceCustomProvider[]>;
  noteCustomProviders: (projectDirectory: string, providers: readonly SpaceCustomProvider[]) => void;
  catalogProviders: ReadonlyMap<string, readonly SpaceCatalogProvider[]>;
  noteCatalogProviders: (projectDirectory: string, providers: readonly SpaceCatalogProvider[]) => void;
  accessDialog: { spaceId: string; providerId: string | null } | null;
  openAccessDialog: (spaceId: string, providerId?: string | null) => void;
  closeAccessDialog: () => void;
  actions: ReadonlyMap<string, SpaceActionState>;
  noteAction: (spaceId: string, state: SpaceActionState | null) => void;
  applyDialog: string | null;
  openApplyDialog: (spaceId: string) => void;
  closeApplyDialog: () => void;
  deleteDialog: string | null;
  deleteUnsaved: SpaceUnsavedChats | null;
  openDeleteDialog: (spaceId: string, unsaved?: SpaceUnsavedChats | null) => void;
  closeDeleteDialog: () => void;
  archivedNotice: string | null;
  noteChatsArchived: (name: string | null) => void;
  setupOutputDialog: string | null;
  openSetupOutputDialog: (spaceId: string) => void;
  closeSetupOutputDialog: () => void;
  actionsSheet: string | null;
  openActionsSheet: (spaceId: string) => void;
  closeActionsSheet: () => void;
  applyMarks: (marks: readonly SpaceMark[]) => void;
  noteStream: (spaceId: string, status: 'connected' | 'disconnected') => void;
  noteReachable: (spaceId: string) => void;
  resetForRuntimeSwitch: () => void;
  forgetForSwitchOff: () => void;
};

const EMPTY: ReadonlyMap<string, SpaceMark> = new Map();

const progressAt = new Map<string, number>();

const withProgress = (entry: SpaceEntry, progress: SpaceProgress & { step: Exclude<SpaceProgress['step'], 'removed'> }): SpaceEntry => (progress.step === 'failed'
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
    const progressRevision = current.progressRevision + 1;
    progressAt.set(entry.id, progressRevision);
    const journey = new Map(current.journey ?? []);
    journey.set(entry.id, entry);
    return { journey, progressRevision };
  }),
  noteTaskTitle: (spaceId, taskTitle) => {
    const current = get();
    const entry = current.journey?.get(spaceId);
    const mark = current.spaces.get(spaceId);
    const progressRevision = current.progressRevision + 1;
    progressAt.set(spaceId, progressRevision);
    const journey = entry ? new Map(current.journey).set(spaceId, { ...entry, taskTitle }) : current.journey;
    const spaces = mark ? new Map(current.spaces).set(spaceId, { ...mark, taskTitle }) : current.spaces;
    set({ journey, spaces, progressRevision });
    return Boolean(entry);
  },
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
      accessFailures: grant.kind === 'domain' ? entry.accessFailures : entry.accessFailures.filter((failure) => failure.provider !== grant.provider),
    });
    return { journey, progressRevision };
  }),
  customProviders: new Map(),
  catalogProviders: new Map(),
  noteCatalogProviders: (projectDirectory, providers) => set((current) => {
    const catalogProviders = new Map(current.catalogProviders);
    catalogProviders.set(projectDirectory, providers);
    return { catalogProviders };
  }),
  noteCustomProviders: (projectDirectory, providers) => set((current) => {
    const customProviders = new Map(current.customProviders);
    customProviders.set(projectDirectory, providers);
    return { customProviders };
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
  applyDialog: null,
  openApplyDialog: (spaceId) => set({ applyDialog: spaceId }),
  closeApplyDialog: () => set({ applyDialog: null }),
  deleteDialog: null,
  deleteUnsaved: null,
  openDeleteDialog: (spaceId, unsaved = null) => set({ deleteDialog: spaceId, deleteUnsaved: unsaved }),
  closeDeleteDialog: () => set({ deleteDialog: null, deleteUnsaved: null }),
  archivedNotice: null,
  noteChatsArchived: (name) => set({ archivedNotice: name }),
  setupOutputDialog: null,
  openSetupOutputDialog: (spaceId) => set({ setupOutputDialog: spaceId }),
  closeSetupOutputDialog: () => set({ setupOutputDialog: null }),
  actionsSheet: null,
  openActionsSheet: (spaceId) => set({ actionsSheet: spaceId }),
  closeActionsSheet: () => set({ actionsSheet: null }),
  noteProgress: (progress) => {
    const revision = get().progressRevision + 1;
    progressAt.set(progress.spaceId, revision);
    const entry = get().journey?.get(progress.spaceId);
    const { step } = progress;
    if (!entry || step === 'removed') {
      set({ progressRevision: revision });
      return false;
    }
    const journey = new Map(get().journey);
    journey.set(progress.spaceId, withProgress(entry, { ...progress, step }));
    set({ journey, progressRevision: revision });
    return true;
  },
  applyMarks: (marks) => set((current) => {
    const next = new Map(marks.map((mark) => [mark.id, mark]));
    if (next.size === 0 && current.spaces.size === 0) return current;
    return { spaces: next };
  }),
  noteStream: (spaceId, status) => set((current) => {
    if (status === 'connected') return current;
    return { spaces: withState(current.spaces, spaceId, 'stale') };
  }),
  noteReachable: (spaceId) => set((current) => ({ spaces: withState(current.spaces, spaceId, 'complete') })),
  resetForRuntimeSwitch: () => {
    progressAt.clear();
    journeyGeneration += 1;
    set({ spaces: EMPTY, journey: null, progressRevision: 0, customProviders: new Map(), catalogProviders: new Map(), accessDialog: null, actions: new Map(), applyDialog: null, deleteDialog: null, deleteUnsaved: null, archivedNotice: null, setupOutputDialog: null, actionsSheet: null });
  },
  forgetForSwitchOff: () => get().resetForRuntimeSwitch(),
}));

let journeyGeneration = 0;

export const spacesRuntimeGeneration = (): number => journeyGeneration;

export const refreshSpacesJourney = async (): Promise<void> => {
  const generation = journeyGeneration;
  const revision = useSpacesStore.getState().progressRevision;
  const { prepareGoneSpaceDraftMove } = await import('./space-drafts');
  const moveGoneSpaceDrafts = prepareGoneSpaceDraftMove();
  const entries = await listSpaces();
  if (generation !== journeyGeneration) return;
  useSpacesStore.getState().applyJourney(entries, revision);
  const listedIds = new Set(entries.map((entry) => entry.id));
  if (Array.from(useSpacesStore.getState().spaces.keys()).some((spaceId) => !listedIds.has(spaceId))) void import('@/stores/useGlobalSessionsStore').then(({ refreshGlobalSessions }) => refreshGlobalSessions()).catch(() => undefined);
  void moveGoneSpaceDrafts(listedIds);
  for (const directory of new Set(entries.flatMap((entry) => (entry.projectDirectory ? [entry.projectDirectory] : [])))) {
    if (!useSpacesStore.getState().customProviders.has(directory)) void loadSpaceCustomProviders(directory);
    if (!useSpacesStore.getState().catalogProviders.has(directory)) void loadSpaceCatalogProviders(directory);
  }
};

useSessionDraftsStore.subscribe((state, previous) => {
  const journey = useSpacesStore.getState().journey;
  if (state.drafts === previous.drafts || !journey) return;
  if (state.drafts.some((draft) => { const spaceId = spaceIdOfDirectory(draft.directory); return spaceId !== null && !journey.has(spaceId); })) void refreshSpacesJourney().catch(() => undefined);
});

const customProviderReads = new Map<string, Promise<void>>();

export const loadSpaceCustomProviders = (projectDirectory: string): Promise<void> => {
  const pending = customProviderReads.get(projectDirectory);
  if (pending) return pending;
  const generation = journeyGeneration;
  const read = readSpaceCustomProviders(projectDirectory)
    .then((providers) => { if (generation === journeyGeneration) useSpacesStore.getState().noteCustomProviders(projectDirectory, providers); })
    .catch(() => undefined)
    .finally(() => { customProviderReads.delete(projectDirectory); });
  customProviderReads.set(projectDirectory, read);
  return read;
};

const catalogProviderReads = new Map<string, Promise<void>>();

export const loadSpaceCatalogProviders = (projectDirectory: string): Promise<void> => {
  const pending = catalogProviderReads.get(projectDirectory);
  if (pending) return pending;
  const generation = journeyGeneration;
  const read = readSpaceCatalogProviders(projectDirectory)
    .then((providers) => { if (generation === journeyGeneration) useSpacesStore.getState().noteCatalogProviders(projectDirectory, providers); })
    .catch(() => undefined)
    .finally(() => { catalogProviderReads.delete(projectDirectory); });
  catalogProviderReads.set(projectDirectory, read);
  return read;
};

export const hasIsolatedSpaces = (): boolean => useSpacesStore.getState().spaces.size > 0;

export const getSpaceMark = (spaceId: string): SpaceMark | null => useSpacesStore.getState().spaces.get(spaceId) ?? null;

const isStoppedEntry = (entry: SpaceEntry | undefined): boolean => entry?.state === 'exited' || entry?.state === 'missing' || entry?.state === 'unreachable';

export const isSpaceStopped = (spaceId: string): boolean => isStoppedEntry(useSpacesStore.getState().journey?.get(spaceId));

const spaceTakesNoNewSession = (entry: SpaceEntry | undefined): boolean => entry?.state === 'failed' || entry?.state === 'missing' || entry?.state === 'unreachable';

export const useSpaceTakesNoNewSession = (spaceId: string | null | undefined): boolean =>
  useSpacesStore((state) => spaceId != null && spaceTakesNoNewSession(state.journey?.get(spaceId)));

export const isSpaceDirectoryClosedToNewSessions = (directory: string | null | undefined): boolean => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId !== null && spaceTakesNoNewSession(useSpacesStore.getState().journey?.get(spaceId));
};

export const spaceProjectDirectoryIn = (state: Pick<SpacesState, 'spaces' | 'journey'>, directory: string | null | undefined): string | null => {
  const spaceId = spaceIdOfDirectory(directory);
  if (spaceId === null) return null;
  return state.spaces.get(spaceId)?.projectDirectory ?? state.journey?.get(spaceId)?.projectDirectory ?? null;
};

export const spaceProjectDirectoryOf = (directory: string | null | undefined): string | null => spaceProjectDirectoryIn(useSpacesStore.getState(), directory);

export const useSpaceProjectDirectory = (directory: string | null | undefined): string | null =>
  useSpacesStore((state) => spaceProjectDirectoryIn(state, directory));

export const isSpaceDirectoryStopped = (directory: string | null | undefined): boolean => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId !== null && isSpaceStopped(spaceId);
};

export const knownSpaceIds = (state: Pick<SpacesState, 'spaces' | 'journey'>): ReadonlySet<string> => (
  new Set([...state.spaces.keys(), ...(state.journey?.keys() ?? [])])
);

export const isDirectoryOfKnownSpace = (directory: string | null | undefined): boolean => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId === null || knownSpaceIds(useSpacesStore.getState()).has(spaceId);
};

export const spaceIdsGone = (previous: ReadonlySet<string>, next: ReadonlySet<string>): string[] => (
  Array.from(previous).filter((spaceId) => !next.has(spaceId))
);

export const useSpaceDirectoryStopped = (directory: string | null | undefined): boolean => {
  const spaceId = spaceIdOfDirectory(directory);
  return useSpacesStore((state) => spaceId !== null && isStoppedEntry(state.journey?.get(spaceId)));
};

const mergeSidebarSpaces = (marks: ReadonlyMap<string, SpaceMark>, journey: ReadonlyMap<string, SpaceEntry> | null): SpaceMark[] => {
  const merged = Array.from(marks.values(), (mark) => {
    const entry = journey?.get(mark.id);
    return entry ? { ...mark, taskTitle: entry.taskTitle ?? null } : mark;
  });
  for (const entry of journey?.values() ?? []) {
    if (marks.has(entry.id) || entry.projectDirectory === null || entry.directory === null) continue;
    merged.push({ id: entry.id, name: entry.name, taskTitle: entry.taskTitle ?? null, state: 'complete', projectDirectory: entry.projectDirectory, directory: entry.directory });
  }
  return merged;
};

export const useSidebarSpaces = (enabled = true): SpaceMark[] => {
  const marks = useSpacesStore((state) => (enabled ? state.spaces : EMPTY));
  const journey = useSpacesStore((state) => (enabled ? state.journey : null));
  return React.useMemo(() => mergeSidebarSpaces(marks, journey), [journey, marks]);
};

export const spacesOfProject = (journey: ReadonlyMap<string, SpaceEntry>, projectPath: string): SpaceEntry[] => {
  const project = normalizePath(projectPath);
  return Array.from(journey.values()).filter((entry) => project !== null && normalizePath(entry.projectDirectory) === project);
};

export const spacesWithoutProject = (journey: ReadonlyMap<string, SpaceEntry>): SpaceEntry[] => (
  Array.from(journey.values()).filter((entry) => entry.projectDirectory === null)
);

type SpacesJourneyRead = { journey: ReadonlyMap<string, SpaceEntry> | null; error: Error | null };

export const useSpacesJourneyRead = (): SpacesJourneyRead => {
  const journey = useSpacesStore((state) => state.journey);
  const [error, setError] = React.useState<Error | null>(null);
  React.useEffect(() => {
    let current = true;
    refreshSpacesJourney().then(
      () => { if (current) setError(null); },
      (failure: Error) => { if (current) setError(failure); },
    );
    return () => { current = false; };
  }, []);
  return { journey, error };
};
