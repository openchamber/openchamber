import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { claimReplyForAutoRead } from './autoReadClaims';

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('claimReplyForAutoRead', () => {
  test('lets only the first window read a reply', async () => {
    const results = await Promise.all([
      claimReplyForAutoRead('msg_1'),
      claimReplyForAutoRead('msg_1'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimReplyForAutoRead('msg_1')).toBe(false);
  });

  test('claims each reply separately', async () => {
    expect(await claimReplyForAutoRead('msg_1')).toBe(true);
    expect(await claimReplyForAutoRead('msg_2')).toBe(true);
  });

  test('keeps only the most recent claims', async () => {
    for (let index = 0; index < 60; index += 1) {
      await claimReplyForAutoRead(`msg_${index}`);
    }
    expect(window.localStorage.getItem('autoReadAloudClaims')?.split('\n')).toHaveLength(50);
    expect(await claimReplyForAutoRead('msg_0')).toBe(true);
  });
});
