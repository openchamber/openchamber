import { beforeEach, describe, expect, test } from 'bun:test';
import { useBtwStore } from './useBtwStore';

beforeEach(() => {
  useBtwStore.setState({ byParent: {} });
});

describe('useBtwStore', () => {
  test('starts empty', () => {
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('opens a compose request with an optional quoted question', () => {
    const opened = useBtwStore.getState().openComposer('parent-1', 'main:parent-1', '/repo', '> selected text');
    expect(opened).toBe(true);
    const request = useBtwStore.getState().byParent['parent-1'];
    expect(request?.status).toBe('compose');
    expect(request?.draft).toBe('> selected text');
    expect(request?.directory).toBe('/repo');
    expect(request?.ownerKey).toBe('main:parent-1');
  });

  test('keeps draft edits on the compose request', () => {
    useBtwStore.getState().openComposer('parent-1', 'main:parent-1', null);
    useBtwStore.getState().setDraft('parent-1', 'why?');
    expect(useBtwStore.getState().byParent['parent-1']?.draft).toBe('why?');
  });

  test('a running request cannot be replaced by another compose', () => {
    expect(useBtwStore.getState().begin('parent-1', 'req-1', 'main:parent-1', 'first', null, 'runtime-1')).toBe(true);
    expect(useBtwStore.getState().openComposer('parent-1', 'main:parent-1', null, 'second')).toBe(false);
    expect(useBtwStore.getState().byParent['parent-1']?.question).toBe('first');
  });

  test('transitions running to answered and failed by request id', () => {
    useBtwStore.getState().begin('parent-1', 'req-1', 'main:parent-1', 'first', null, 'runtime-1');
    useBtwStore.getState().succeed('parent-1', 'stale', 'wrong answer', 1);
    expect(useBtwStore.getState().byParent['parent-1']?.status).toBe('running');

    useBtwStore.getState().succeed('parent-1', 'req-1', 'answer', 2);
    expect(useBtwStore.getState().byParent['parent-1']).toMatchObject({
      status: 'answered',
      answer: 'answer',
      completedAt: 2,
    });

    useBtwStore.setState({ byParent: {} });
    useBtwStore.getState().begin('parent-1', 'req-2', 'main:parent-1', 'second', null, 'runtime-1');
    useBtwStore.getState().fail('parent-1', 'req-2', 'timeout');
    expect(useBtwStore.getState().byParent['parent-1']).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout' },
    });
  });

  test('dismiss removes only its parent', () => {
    useBtwStore.getState().begin('parent-1', 'req-1', 'main:parent-1', 'first', null, 'runtime-1');
    useBtwStore.getState().openComposer('parent-2', 'main:parent-2', null, 'second');
    useBtwStore.getState().dismiss('parent-1');
    expect(useBtwStore.getState().byParent['parent-1']).toBeUndefined();
    expect(useBtwStore.getState().byParent['parent-2']?.status).toBe('compose');
  });

  test('empty questions do not begin a request', () => {
    expect(useBtwStore.getState().begin('parent-1', 'req-1', 'main:parent-1', '   ', null, 'runtime-1')).toBe(false);
    expect(useBtwStore.getState().byParent['parent-1']).toBeUndefined();
  });
});
