import { createPlanSaveQueue } from './planSaveQueue';
import type { SavedPlanBuffer } from './savedPlanRefresh';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';

export interface RetainedPlanBuffer extends SavedPlanBuffer {
  saveError: string | null;
}

interface SavedPlanDrafts {
  queue: ReturnType<typeof createPlanSaveQueue>;
  retire: () => void;
  edit: (key: string, buffer: RetainedPlanBuffer, content: string) => void;
  schedule: (key: string, revision: number, buffer: RetainedPlanBuffer, write: () => Promise<void>) => Promise<void>;
  retain: (key: string, buffer: RetainedPlanBuffer) => void;
  restore: (key: string) => RetainedPlanBuffer | undefined;
  deleted: (key: string) => void;
}

/** Page-lifetime ownership of unsaved project plans. No persistence or eviction. */
export const createSavedPlanDrafts = (): SavedPlanDrafts => {
  const drafts = new Map<string, RetainedPlanBuffer>();
  const deletions = new Map<string, { revision: number; deleted: boolean }>();
  const queue = createPlanSaveQueue();
  let generation = 0;
  let editRevision = 0;
  const retain = (key: string, buffer: RetainedPlanBuffer) => {
    if (deletions.get(key)?.deleted) buffer.deleted = true;
    const retained = drafts.get(key);
    if (!buffer.deleted && buffer.editRevision > buffer.savedRevision) {
      if (!retained || retained.editRevision <= buffer.editRevision) drafts.set(key, buffer);
    } else if (retained === buffer) drafts.delete(key);
  };
  return {
    queue,
    retire: () => { generation += 1; },
    edit: (key: string, buffer: RetainedPlanBuffer, content: string) => {
      buffer.content = content;
      // Two mounted views of one plan must not share a queue revision.
      buffer.editRevision = ++editRevision;
      retain(key, buffer);
    },
    schedule: (key: string, revision: number, buffer: RetainedPlanBuffer, write: () => Promise<void>) => {
      const capturedGeneration = generation;
      const deletionRevision = deletions.get(key)?.revision ?? 0;
      return queue.schedule(key, revision, async () => {
        if (generation !== capturedGeneration || deletionRevision !== (deletions.get(key)?.revision ?? 0) || buffer.deleted) return;
        await write();
      });
    },
    retain,
    // Call only after an authoritative read confirms an existing plan and the
    // outgoing queue settles. A deleted plan never restores its old draft.
    restore: (key: string): RetainedPlanBuffer | undefined => {
      const deletion = deletions.get(key);
      if (deletion) deletion.deleted = false;
      return drafts.get(key);
    },
    deleted: (key: string) => {
      deletions.set(key, { revision: (deletions.get(key)?.revision ?? 0) + 1, deleted: true });
      const buffer = drafts.get(key);
      if (buffer) buffer.deleted = true;
      drafts.delete(key);
    },
  };
};

let pageDrafts: ReturnType<typeof createSavedPlanDrafts> | undefined;
export const getSavedPlanDrafts = () => {
  if (!pageDrafts) {
    const drafts = createSavedPlanDrafts();
    pageDrafts = drafts;
    // Remain subscribed while PlanView is unmounted so A-B-A cannot revive writes.
    subscribeRuntimeEndpointChanged((detail) => {
      if (detail.runtimeKey !== detail.previousRuntimeKey) drafts.retire();
    });
  }
  return pageDrafts;
};
