import { beforeEach, describe, expect, test } from 'bun:test';
import { IMAGE_JOB_LIFETIME_MS, type RunningImageJob } from '@/lib/opencode/background-image';
import type { SyncEvent } from '@/lib/opencode/events';
import {
  applyBackgroundImageEvents,
  backgroundImageRevision,
  backgroundImagesOfSessions,
  refreshBackgroundImages,
  replaceImageJobs,
  resetBackgroundImages,
  useBackgroundImagesStore,
} from './background-images';

// The `image_generate` call settles at once with its job in the metadata.
const started = (jobID: string, sessionID = 'ses_1', end = Date.now()): SyncEvent => ({
  type: 'message.tool.transition',
  properties: {
    sessionID,
    messageID: 'msg_1',
    partID: `call_${jobID}`,
    transition: { kind: 'success', output: '', metadata: { path: `/tmp/images/${jobID}`, model: 'openai/gpt-image-2', jobID }, executed: true, end },
  },
});
// OpenCode reports the saved (or failed) image in a synthetic message.
const finished = (jobID: string): SyncEvent => ({
  type: 'message.updated',
  properties: {
    info: {
      id: `msg_${jobID}`,
      sessionID: 'ses_1',
      role: 'synthetic',
      text: 'Image request finished.',
      metadata: { source: 'experimental_image_generate', jobID, state: 'completed', path: `/tmp/images/${jobID}` },
      time: { created: 3000 },
    },
  },
});
const job = (id: string, sessionID = 'ses_1', startedAt = Date.now()): RunningImageJob => ({ id, sessionID, path: `/tmp/images/${id}`, model: 'openai/gpt-image-2', startedAt });

const ids = () => [...useBackgroundImagesStore.getState().byId.keys()].sort();
const sessions = () => [...useBackgroundImagesStore.getState().sessionIds].sort();

beforeEach(() => resetBackgroundImages());

describe('background image index', () => {
  test('tracks an image from the settled call to its notice', () => {
    applyBackgroundImageEvents('/repo', [started('image_1'), started('image_2', 'ses_2')]);
    expect(ids()).toEqual(['image_1', 'image_2']);
    expect(sessions()).toEqual(['ses_1', 'ses_2']);
    expect(useBackgroundImagesStore.getState().byId.get('image_1')).toMatchObject({ id: 'image_1', sessionID: 'ses_1', inSpace: false });

    applyBackgroundImageEvents('/repo', [finished('image_1')]);
    expect(sessions()).toEqual(['ses_2']);
  });

  test('ignores other settled calls, such as a background command', () => {
    const before = useBackgroundImagesStore.getState();
    applyBackgroundImageEvents('/repo', [{
      type: 'message.tool.transition',
      properties: { sessionID: 'ses_1', messageID: 'm', partID: 'p', transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_1' }, executed: true, end: 1 } },
    }]);
    expect(useBackgroundImagesStore.getState()).toBe(before);
  });

  test('a notice that arrives first keeps a later start from bringing the image back', () => {
    applyBackgroundImageEvents('/repo', [finished('image_1')]);
    applyBackgroundImageEvents('/repo', [started('image_1')]);
    expect(ids()).toEqual([]);
  });

  test('a job list clears an image whose notice fell into a gap and adds one it did not see', () => {
    applyBackgroundImageEvents('/repo', [started('image_gap')]);
    replaceImageJobs([job('image_new')], backgroundImageRevision());
    expect(ids()).toEqual(['image_new']);
  });

  test('a job list read before an event does not undo it', () => {
    const since = backgroundImageRevision();
    applyBackgroundImageEvents('/repo', [started('image_1')]);
    replaceImageJobs([], since);
    expect(ids()).toEqual(['image_1']);

    const later = backgroundImageRevision();
    applyBackgroundImageEvents('/repo', [finished('image_1')]);
    replaceImageJobs([job('image_1')], later);
    expect(ids()).toEqual([]);
  });

  test('a failed read changes nothing, and an OpenCode without a job list leaves the events in charge', async () => {
    applyBackgroundImageEvents('/repo', [started('image_1')]);
    await expect(refreshBackgroundImages(async () => { throw new Error('down'); })).rejects.toThrow('down');
    await refreshBackgroundImages(async () => null);
    expect(ids()).toEqual(['image_1']);
  });

  test('a read that outlives a runtime switch is dropped', async () => {
    let answer: (jobs: RunningImageJob[]) => void = () => {};
    const read = refreshBackgroundImages(() => new Promise((resolve) => { answer = resolve; }));
    resetBackgroundImages();
    answer([job('image_old')]);
    await read;
    expect(ids()).toEqual([]);
  });

  test('lists the images of the given sessions, oldest first', () => {
    const now = Date.now();
    applyBackgroundImageEvents('/repo', [started('image_b', 'ses_child', now - 1000), started('image_a', 'ses_1', now - 3000), started('image_x', 'ses_other')]);
    const picked = backgroundImagesOfSessions(useBackgroundImagesStore.getState().byId, new Set(['ses_1', 'ses_child']));
    expect(picked.map((item) => item.id)).toEqual(['image_a', 'image_b']);
  });

  test('the host job list leaves an image started in an isolated space alone', () => {
    applyBackgroundImageEvents('/spaces/0123456789ab/app', [started('image_space')]);
    replaceImageJobs([], backgroundImageRevision());
    expect(ids()).toEqual(['image_space']);
  });

  test('an older read that answers after a newer one changes nothing', async () => {
    const answers: Array<(jobs: RunningImageJob[]) => void> = [];
    const list = () => new Promise<RunningImageJob[]>((resolve) => { answers.push(resolve); });
    const older = refreshBackgroundImages(list);
    const newer = refreshBackgroundImages(list);
    answers[1]([job('image_1')]);
    await newer;
    answers[0]([]);
    await older;
    expect(ids()).toEqual(['image_1']);
  });

  test('an older read still applies when the newer one failed', async () => {
    const settle: Array<{ resolve: (jobs: RunningImageJob[]) => void; reject: (error: Error) => void }> = [];
    const list = () => new Promise<RunningImageJob[]>((resolve, reject) => { settle.push({ resolve, reject }); });
    const older = refreshBackgroundImages(list);
    const newer = refreshBackgroundImages(list);
    settle[1].reject(new Error('down'));
    await expect(newer).rejects.toThrow('down');
    settle[0].resolve([job('image_1')]);
    await older;
    expect(ids()).toEqual(['image_1']);
  });

  test('an image past OpenCode\'s image timeout leaves the index on its own', async () => {
    replaceImageJobs([job('image_stale', 'ses_1', Date.now() - IMAGE_JOB_LIFETIME_MS + 20)], backgroundImageRevision());
    expect(ids()).toEqual(['image_stale']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ids()).toEqual([]);
  });
});
