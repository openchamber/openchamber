import { describe, expect, test } from 'bun:test';

import {
  GUEST_GENERATE_LATE_KEEP_MS,
  GUEST_GENERATE_LATE_MAX,
  OPENCHAMBER_SDK_API_VERSION,
  OPENCHAMBER_SDK_CHANNEL,
  type LateGenerateResult,
} from '@openchamber/sdk';

import { createGuestGenerateResults, lateGenerateResult, type GenerateOwner } from './generate-results.ts';
import type { InstalledGuest } from './types.ts';

const writer: InstalledGuest = {
  id: 'writer',
  storageId: 'store-1',
  name: 'Writer',
  icon: 'window',
  entry: 'panel/index.html',
  source: 'path',
  capabilities: { requested: ['model'], granted: ['model'] },
};

const owner: GenerateOwner = { runtimeKey: 'local', guestId: 'writer', storageId: 'store-1', surface: 'panel', directory: '/repo' };

const answer = (text: string): LateGenerateResult => ({ request: { prompt: `Write ${text}` }, ok: true, result: { text } });

const setup = () => {
  const clock = { now: 1_000 };
  const catalog = { status: 'ready', runtimeKey: 'local', guests: [writer] };
  const catalogListeners = new Set<() => void>();
  const results = createGuestGenerateResults({
    now: () => clock.now,
    readCatalog: () => catalog,
    subscribeCatalog: (listener) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
  });
  const setCatalog = (guests: InstalledGuest[], status = 'ready') => {
    catalog.guests = guests;
    catalog.status = status;
    for (const listener of [...catalogListeners]) listener();
  };
  const frame = (frameOwner: GenerateOwner = owner, accepts = true) => {
    const received: LateGenerateResult[] = [];
    const stop = results.listen({
      owner: () => frameOwner,
      deliver: (result) => {
        if (!accepts) return false;
        received.push(result);
        return true;
      },
    });
    return { received, stop };
  };
  return { clock, results, setCatalog, frame, catalogListeners };
};

describe('guest generate results', () => {
  test('an answer whose frame is gone waits for the next frame and is handed over once', () => {
    const { results, frame } = setup();
    results.keep(owner, answer('first'));
    results.keep(owner, answer('second'));
    const reopened = frame();
    expect(reopened.received.map((result) => result.ok && result.result.text)).toEqual(['first', 'second']);
    reopened.stop();
    expect(frame().received).toEqual([]);
  });

  test('an answer that lands while a frame listens goes straight to it', () => {
    const { results, frame } = setup();
    const open = frame();
    results.keep(owner, answer('now'));
    expect(open.received).toHaveLength(1);
    open.stop();
    expect(frame().received).toEqual([]);
  });

  test('a frame that cannot take it now leaves it kept', () => {
    const { results, frame } = setup();
    frame(owner, false);
    results.keep(owner, answer('later'));
    expect(frame().received).toHaveLength(1);
  });

  test('another surface, project, installation or runtime does not get it', () => {
    const { results, frame } = setup();
    results.keep(owner, answer('mine'));
    expect(frame({ ...owner, surface: 'dialog' }).received).toEqual([]);
    expect(frame({ ...owner, directory: '/other' }).received).toEqual([]);
    expect(frame({ ...owner, storageId: 'store-2' }).received).toEqual([]);
    expect(frame({ ...owner, runtimeKey: 'remote' }).received).toEqual([]);
    expect(frame().received).toHaveLength(1);
  });

  test('a failed generation is kept as its error', () => {
    const { results, frame } = setup();
    const failed: LateGenerateResult = { request: { prompt: 'x' }, ok: false, code: 'MODEL_FAILED', error: 'Failed.' };
    results.keep(owner, failed);
    expect(frame().received).toEqual([failed]);
  });

  test('uninstalling or disabling the extension drops what it had waiting', () => {
    const { results, setCatalog, frame, catalogListeners } = setup();
    results.keep(owner, answer('gone'));
    expect(catalogListeners.size).toBe(1);
    setCatalog([]);
    expect(catalogListeners.size).toBe(0);
    setCatalog([writer]);
    expect(frame().received).toEqual([]);

    results.keep(owner, answer('paused'));
    setCatalog([{ ...writer, enabled: false }]);
    setCatalog([writer]);
    expect(frame().received).toEqual([]);

    results.keep(owner, answer('reinstalled'));
    setCatalog([{ ...writer, storageId: 'store-2' }]);
    expect(frame().received).toEqual([]);
  });

  test('an answer for an extension that is already gone is not kept', () => {
    const { results, setCatalog, frame } = setup();
    setCatalog([{ ...writer, capabilities: { requested: ['model'], granted: [] } }]);
    results.keep(owner, answer('unapproved'));
    setCatalog([writer]);
    expect(frame().received).toEqual([]);
  });

  test('a catalog that is still loading drops nothing', () => {
    const { results, setCatalog, frame } = setup();
    results.keep(owner, answer('kept'));
    setCatalog([], 'loading');
    setCatalog([writer]);
    expect(frame().received).toHaveLength(1);
  });

  test(`keeps at most ${GUEST_GENERATE_LATE_MAX} per extension, dropping the oldest`, () => {
    const { results, frame } = setup();
    for (let index = 0; index <= GUEST_GENERATE_LATE_MAX; index += 1) results.keep(owner, answer(`#${index}`));
    const texts = frame().received.map((result) => result.ok && result.result.text);
    expect(texts).toHaveLength(GUEST_GENERATE_LATE_MAX);
    expect(texts[0]).toBe('#1');
  });

  test('drops the oldest answers once all kept text passes the size cap', () => {
    const { results, setCatalog, frame } = setup();
    setCatalog([writer, { ...writer, id: 'other' }]);
    const big = (label: string): LateGenerateResult => ({ request: { prompt: label }, ok: true, result: { text: 'x'.repeat(900_000) } });
    results.keep(owner, big('one'));
    results.keep({ ...owner, guestId: 'other' }, big('two'));
    results.keep(owner, big('three'));
    expect(frame().received.map((result) => result.request.prompt)).toEqual(['three']);
    expect(frame({ ...owner, guestId: 'other' }).received.map((result) => result.request.prompt)).toEqual(['two']);
  });

  test('an answer nobody took expires', () => {
    const { clock, results, frame } = setup();
    results.keep(owner, answer('stale'));
    clock.now += GUEST_GENERATE_LATE_KEEP_MS;
    expect(frame().received).toEqual([]);
  });

  test('reads the outcome from the reply the frame would have got', () => {
    const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'result', id: 'oc-1' } as const;
    const request = { prompt: 'Summarize' };
    expect(lateGenerateResult(request, { ...envelope, ok: true, payload: { text: 'Short.' } })).toEqual({ request, ok: true, result: { text: 'Short.' } });
    expect(lateGenerateResult(request, { ...envelope, ok: false, code: 'NO_MODEL', error: 'No model.' })).toEqual({ request, ok: false, code: 'NO_MODEL', error: 'No model.' });
    expect(lateGenerateResult(request, { ...envelope, ok: true })).toBeNull();
  });
});
