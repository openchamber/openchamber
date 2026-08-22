import { describe, expect, test } from 'bun:test';
import type { GitCommitHoverDetailsKey, GitHubCommitDetails } from '@/lib/api/types';
import { createGitCommitHoverDetailsCache, preloadGitCommitHoverImage } from './gitCommitHoverCache';

const key: GitCommitHoverDetailsKey = {
  directory: '/repo',
  remoteName: 'origin',
  hash: 'a'.repeat(40),
};

describe('createGitCommitHoverDetailsCache', () => {
  test('preloadGitCommitHoverImage resolves false when the runtime has no Image constructor', async () => {
    expect(await preloadGitCommitHoverImage('https://avatars.githubusercontent.com/u/1', undefined)).toBe(false);
  });

  test('preloadGitCommitHoverImage resolves from image load and error callbacks', async () => {
    class SuccessfulImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    class FailingImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        this.onerror?.();
      }
    }

    expect(await preloadGitCommitHoverImage('https://avatars.githubusercontent.com/u/1', SuccessfulImage)).toBe(true);
    expect(await preloadGitCommitHoverImage('https://avatars.githubusercontent.com/u/2', FailingImage)).toBe(false);
  });

  test('does not load on construction or snapshot reads and dedupes in-flight preload work', async () => {
    let loaderCalls = 0;
    const cache = createGitCommitHoverDetailsCache({
      load: async () => {
        loaderCalls += 1;
        return { connected: true };
      },
      preloadImage: async () => true,
    });

    expect(loaderCalls).toBe(0);
    expect(cache.getSnapshot(key)).toEqual({ status: 'idle' });
    expect(loaderCalls).toBe(0);

    await Promise.all([cache.preload(key), cache.preload(key)]);
    expect(loaderCalls).toBe(1);
    expect(cache.getSnapshot(key)).toEqual({ status: 'ready', details: { connected: true } });
  });

  test('reuses positive entries across later preload calls', async () => {
    let loaderCalls = 0;
    const cache = createGitCommitHoverDetailsCache({
      load: async () => {
        loaderCalls += 1;
        return { connected: true, url: 'https://github.com/owner/repo/commit/1' };
      },
      preloadImage: async () => true,
    });

    await cache.preload(key);
    await cache.preload(key);

    expect(loaderCalls).toBe(1);
  });

  test('expires negative entries after the default 60 second ttl', async () => {
    let now = 1_000;
    let loaderCalls = 0;
    const cache = createGitCommitHoverDetailsCache({
      load: async () => {
        loaderCalls += 1;
        throw new Error('offline');
      },
      preloadImage: async () => true,
      now: () => now,
    });

    await cache.preload(key);
    expect(cache.getSnapshot(key)).toEqual({ status: 'unavailable' });

    now += 59_999;
    expect(cache.getSnapshot(key)).toEqual({ status: 'unavailable' });

    now += 2;
    expect(cache.getSnapshot(key)).toEqual({ status: 'idle' });
    await cache.preload(key);
    expect(loaderCalls).toBe(2);
  });

  test('separates keys by directory remote and hash', async () => {
    const seen: GitCommitHoverDetailsKey[] = [];
    const cache = createGitCommitHoverDetailsCache({
      load: async (currentKey) => {
        seen.push(currentKey);
        return { connected: true, url: currentKey.hash };
      },
      preloadImage: async () => true,
    });

    await cache.preload(key);
    await cache.preload({ ...key, directory: '/repo-b' });
    await cache.preload({ ...key, remoteName: 'upstream' });
    await cache.preload({ ...key, hash: 'b'.repeat(40) });

    expect(seen).toEqual([
      key,
      { ...key, directory: '/repo-b' },
      { ...key, remoteName: 'upstream' },
      { ...key, hash: 'b'.repeat(40) },
    ]);
  });

  test('notifies only listeners subscribed to the matching key', async () => {
    let matchingNotifications = 0;
    let otherNotifications = 0;
    const cache = createGitCommitHoverDetailsCache({
      load: async () => ({ connected: true }),
      preloadImage: async () => true,
    });

    cache.subscribe(key, () => {
      matchingNotifications += 1;
    });
    cache.subscribe({ ...key, hash: 'f'.repeat(40) }, () => {
      otherNotifications += 1;
    });

    await cache.preload(key);

    expect(matchingNotifications).toBeGreaterThan(0);
    expect(otherNotifications).toBe(0);
  });

  test('publishes ready only after avatar preloading succeeds', async () => {
    let resolveImage!: (value: boolean) => void;
    const imagePromise = new Promise<boolean>((resolve) => {
      resolveImage = resolve;
    });
    const details: GitHubCommitDetails = {
      connected: true,
      author: {
        login: 'ada',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      },
    };
    const cache = createGitCommitHoverDetailsCache({
      load: async () => details,
      preloadImage: () => imagePromise,
    });

    const preload = cache.preload(key);
    expect(cache.getSnapshot(key)).toEqual({ status: 'loading' });

    resolveImage(true);
    await preload;

    expect(cache.getSnapshot(key)).toEqual({ status: 'ready', details });
  });

  test('bounds positive entries to 200 while preserving subscribed and in-flight entries', async () => {
    let resolveProtected!: (details: GitHubCommitDetails) => void;
    const protectedPromise = new Promise<GitHubCommitDetails>((resolve) => {
      resolveProtected = resolve;
    });
    const cache = createGitCommitHoverDetailsCache({
      load: (currentKey) => {
        if (currentKey.hash === 'f'.repeat(40)) {
          return protectedPromise;
        }
        return Promise.resolve({ connected: true, url: currentKey.hash });
      },
      preloadImage: async () => true,
      maxPositiveEntries: 200,
    });

    const protectedKey = { ...key, hash: 'f'.repeat(40) };
    cache.subscribe({ ...key, hash: '0'.repeat(40) }, () => {});

    const protectedLoad = cache.preload(protectedKey);
    for (let index = 0; index < 201; index += 1) {
      await cache.preload({ ...key, hash: index.toString(16).padStart(40, '0') });
    }

    expect(cache.getSnapshot({ ...key, hash: '0'.repeat(40) })).toEqual({
      status: 'ready',
      details: { connected: true, url: '0'.repeat(40) },
    });
    expect(cache.getSnapshot(protectedKey)).toEqual({ status: 'loading' });
    expect(cache.getSnapshot({ ...key, hash: '1'.padStart(40, '0') })).toEqual({ status: 'idle' });

    resolveProtected({ connected: true, url: protectedKey.hash });
    await protectedLoad;
    expect(cache.getSnapshot(protectedKey)).toEqual({
      status: 'ready',
      details: { connected: true, url: protectedKey.hash },
    });
  });

  test('dispose prevents later notifications', async () => {
    let notifications = 0;
    let resolveLoader!: (details: GitHubCommitDetails) => void;
    const cache = createGitCommitHoverDetailsCache({
      load: () => new Promise<GitHubCommitDetails>((resolve) => {
        resolveLoader = resolve;
      }),
      preloadImage: async () => true,
    });

    cache.subscribe(key, () => {
      notifications += 1;
    });
    const preload = cache.preload(key);
    cache.dispose();
    resolveLoader({ connected: true });
    await preload;

    expect(notifications).toBe(1);
    expect(cache.getSnapshot(key)).toEqual({ status: 'idle' });
  });
});
