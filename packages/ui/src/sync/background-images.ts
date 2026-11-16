import { create } from 'zustand';
import { IMAGE_JOB_LIFETIME_MS, readImageJobEnd, readImageJobStart, type RunningImageJob } from '@/lib/opencode/background-image';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import type { SyncEvent } from '@/lib/opencode/events';

// Index of the images OpenCode is generating in the background for a session.
// Like a background command, an image job outlives the turn that started it:
// the session goes idle and runs again when the image is saved, so this index
// keeps that pause visible as work (see `useSessionTurnActivity`) and lists
// the job above the composer.
//
// OpenCode announces no image job on the event stream. Its live start is the
// `image_generate` call settling with the job in its metadata, and its live end
// the synthetic message reporting the image (see `background-image.ts`). The
// job list (OpenCode 2.2.6+) is authoritative for every session at once; it is
// read at startup and after the stream reconnects, which clears jobs whose end
// fell into a gap. An older OpenCode has no job list, and the events alone
// keep the index. The list is the host OpenCode's: an isolated space runs its
// own, so a space's images are kept by its events alone.
//
// A job outlives OpenCode's 30-minute image timeout only when the OpenCode
// generating it stopped, so the index drops it then.

type TrackedImageJob = RunningImageJob & {
  /** Started in an isolated space, which the host's job list does not cover. */
  inSpace: boolean;
};

type BackgroundImagesState = {
  byId: ReadonlyMap<string, TrackedImageJob>;
  /** Sessions with at least one image in progress. */
  sessionIds: ReadonlySet<string>;
};

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
const MAX_TOUCHED = 500;

export const useBackgroundImagesStore = create<BackgroundImagesState>()(() => ({
  byId: new Map(),
  sessionIds: EMPTY_SESSION_IDS,
}));

// A list read reflects OpenCode as it was when the read started: a job an
// event started or ended since then keeps what the event said.
let revision = 0;
let generation = 0;
// A read that answers after a newer one applied would undo it, so it is
// dropped; one whose newer reads failed still applies.
let readCount = 0;
let appliedRead = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const touchedAt = new Map<string, number>();
// An end that arrives before its start (or for a job the index never saw)
// keeps a later start or list read from bringing the job back.
const ended = new Set<string>();

const remember = (set: Set<string> | Map<string, number>, id: string): void => {
  if (set.size <= MAX_TOUCHED) return;
  const oldest = set.keys().next().value;
  if (oldest !== undefined && oldest !== id) set.delete(oldest);
};

const touch = (id: string): void => {
  revision += 1;
  touchedAt.delete(id);
  touchedAt.set(id, revision);
  remember(touchedAt, id);
};

const touchedSince = (id: string, since: number): boolean => (touchedAt.get(id) ?? 0) > since;

const sessionIdsOf = (byId: ReadonlyMap<string, TrackedImageJob>, previous: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const job of byId.values()) next.add(job.sessionID);
  const same = next.size === previous.size && [...next].every((id) => previous.has(id));
  return same ? previous : next;
};

const expiresAt = (job: RunningImageJob): number => job.startedAt + IMAGE_JOB_LIFETIME_MS;

/** Arms one timer for the job that expires first. */
const scheduleExpiry = (byId: ReadonlyMap<string, TrackedImageJob>): void => {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  let next = Infinity;
  for (const job of byId.values()) next = Math.min(next, expiresAt(job));
  if (next === Infinity) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const current = useBackgroundImagesStore.getState().byId;
    const now = Date.now();
    const kept = new Map([...current].filter(([, job]) => expiresAt(job) > now));
    if (kept.size === current.size) scheduleExpiry(current);
    else publish(kept);
  }, Math.max(0, next - Date.now()));
};

const publish = (byId: Map<string, TrackedImageJob>): void => {
  const state = useBackgroundImagesStore.getState();
  useBackgroundImagesStore.setState({ byId, sessionIds: sessionIdsOf(byId, state.sessionIds) });
  scheduleExpiry(byId);
};

/** Applies image job starts and ends from one directory's stream. Other event types are ignored cheaply. */
export const applyBackgroundImageEvents = (directory: string, payloads: readonly SyncEvent[]): void => {
  let draft: Map<string, TrackedImageJob> | null = null;
  const current = (): ReadonlyMap<string, TrackedImageJob> => draft ?? useBackgroundImagesStore.getState().byId;
  for (const payload of payloads) {
    if (payload.type === 'message.tool.transition') {
      const { transition, sessionID } = payload.properties;
      if (transition.kind !== 'success') continue;
      const started = readImageJobStart(transition.metadata);
      if (!started || ended.has(started.id) || current().has(started.id)) continue;
      touch(started.id);
      draft ??= new Map(current());
      draft.set(started.id, { ...started, sessionID, startedAt: transition.end, inSpace: isSpaceDirectory(directory) });
      continue;
    }
    if (payload.type === 'message.updated') {
      const jobID = readImageJobEnd(payload.properties.info);
      if (jobID === undefined) continue;
      touch(jobID);
      ended.add(jobID);
      remember(ended, jobID);
      if (!current().has(jobID)) continue;
      draft ??= new Map(current());
      draft.delete(jobID);
    }
  }
  if (draft) publish(draft);
};

/**
 * Replaces the host's jobs in the index with its complete job list. `since`
 * is the revision the read started at (`backgroundImageRevision()`).
 */
export const replaceImageJobs = (jobs: readonly RunningImageJob[], since: number): void => {
  const state = useBackgroundImagesStore.getState();
  let draft: Map<string, TrackedImageJob> | null = null;
  const listed = new Set(jobs.map((job) => job.id));
  for (const [id, job] of state.byId) {
    if (job.inSpace || listed.has(id) || touchedSince(id, since)) continue;
    draft ??= new Map(state.byId);
    draft.delete(id);
  }
  for (const job of jobs) {
    if (touchedSince(job.id, since) || ended.has(job.id) || state.byId.has(job.id)) continue;
    draft ??= new Map(state.byId);
    draft.set(job.id, { ...job, inSpace: false });
  }
  if (draft) publish(draft);
};

/**
 * Reads the job list and applies it. A failed read rejects and changes
 * nothing; an OpenCode without a job list leaves the index to the events.
 */
export const refreshBackgroundImages = async (
  listRunningImageJobs: () => Promise<RunningImageJob[] | null>,
): Promise<void> => {
  const startedGeneration = generation;
  const read = ++readCount;
  const since = revision;
  const jobs = await listRunningImageJobs();
  if (jobs === null || startedGeneration !== generation || read < appliedRead) return;
  appliedRead = read;
  replaceImageJobs(jobs, since);
};

export const backgroundImageRevision = (): number => revision;

export const hasRunningImage = (sessionId: string): boolean => (
  useBackgroundImagesStore.getState().sessionIds.has(sessionId)
);

export const resetBackgroundImages = (): void => {
  generation += 1;
  revision = 0;
  touchedAt.clear();
  ended.clear();
  appliedRead = readCount;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  useBackgroundImagesStore.setState({ byId: new Map(), sessionIds: EMPTY_SESSION_IDS });
};

/** Images the given sessions are generating, oldest first. */
export const backgroundImagesOfSessions = (
  byId: ReadonlyMap<string, TrackedImageJob>,
  sessionIds: ReadonlySet<string>,
): TrackedImageJob[] => {
  const jobs: TrackedImageJob[] = [];
  for (const job of byId.values()) {
    if (sessionIds.has(job.sessionID)) jobs.push(job);
  }
  return jobs.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
};
