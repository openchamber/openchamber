import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import {
  compareReleaseVersions,
  fetchLatestMobileRelease,
  MOBILE_RELEASE_FETCH_TIMEOUT_MS,
} from '@/lib/mobileReleaseUpdate';

describe('compareReleaseVersions', () => {
  test('orders plain numeric versions', () => {
    expect(compareReleaseVersions('2.3.3', '2.3.2')).toBe(1);
    expect(compareReleaseVersions('2.3.2', '2.3.3')).toBe(-1);
    expect(compareReleaseVersions('2.3.3', '2.3.3')).toBe(0);
    expect(compareReleaseVersions('3.0', '2.9.9')).toBe(1);
    expect(compareReleaseVersions('2.3', '2.3.0')).toBe(0);
  });

  test('accepts a leading v and never claims an update for unparseable versions', () => {
    expect(compareReleaseVersions('v2.4.0', '2.3.3')).toBe(1);
    expect(compareReleaseVersions('2.4.0', 'dev')).toBe(0);
    expect(compareReleaseVersions('', '2.3.3')).toBe(0);
  });

  test('rejects malformed numeric parts Number() would otherwise accept', () => {
    // Number('') === 0, Number('0x10') === 16, Number('1e3') === 1000:
    // none of these are plain numeric version components.
    expect(compareReleaseVersions('2..4', '2.0.3')).toBe(0);
    expect(compareReleaseVersions('v3.', '2.3.3')).toBe(0);
    expect(compareReleaseVersions('..', '0.0.0')).toBe(0);
    expect(compareReleaseVersions('0x10.0', '2.3.3')).toBe(0);
    expect(compareReleaseVersions('1e3.0', '2.3.3')).toBe(0);
    expect(compareReleaseVersions('2.4.0', '2..3')).toBe(0);
  });

  test('orders a prerelease below the same numeric release', () => {
    expect(compareReleaseVersions('2.3.3', '2.3.3-beta.1')).toBe(1);
    expect(compareReleaseVersions('2.3.3-beta.1', '2.3.3')).toBe(-1);
    expect(compareReleaseVersions('2.3.3-beta.1', '2.3.3-beta.2')).toBe(0);
    expect(compareReleaseVersions('2.3.4-beta.1', '2.3.3')).toBe(1);
    expect(compareReleaseVersions('2.3.3-beta.1', '2.3.4')).toBe(-1);
  });

  test('ignores a +build suffix instead of treating the version as unparseable', () => {
    expect(compareReleaseVersions('2.3.4', '2.3.3+45')).toBe(1);
    expect(compareReleaseVersions('2.3.3+45', '2.3.3')).toBe(0);
    expect(compareReleaseVersions('2.3.3', '2.3.3+45')).toBe(0);
    expect(compareReleaseVersions('2.3.3+45', '2.3.4')).toBe(-1);
    expect(compareReleaseVersions('2.3.3-beta.1+45', '2.3.3')).toBe(-1);
  });
});

const releaseJson = () => ({
  tag_name: 'v2.4.0',
  html_url: 'https://github.com/developing-today-forks/openchamber/releases/tag/v2.4.0',
  assets: [
    {
      name: 'OpenChamber-2.4.0-7-android.aab',
      browser_download_url: 'https://example.com/app.aab',
    },
    {
      name: 'OpenChamber-2.4.0-7-android.apk',
      browser_download_url: 'https://example.com/app.apk',
    },
  ],
});

const fetchReturning = (json: string, ok = true) =>
  async () => new Response(json, { status: ok ? 200 : 403 });

const fetchRelease = () => fetchReturning(JSON.stringify(releaseJson()));

describe('fetchLatestMobileRelease', () => {
  test('reports a newer release with its page and canonical APK asset', async () => {
    const info = await fetchLatestMobileRelease('2.3.3', fetchRelease());
    expect(info?.available).toBe(true);
    expect(info?.version).toBe('2.4.0');
    expect(info?.currentVersion).toBe('2.3.3');
    expect(info?.releaseUrl).toBe('https://github.com/developing-today-forks/openchamber/releases/tag/v2.4.0');
    expect(info?.downloadUrl).toBe('https://example.com/app.apk');
  });

  test('falls back to any APK asset when the canonical name is absent', async () => {
    const body = {
      tag_name: 'v2.4.0',
      html_url: 'https://github.com/developing-today-forks/openchamber/releases/tag/v2.4.0',
      assets: [{ name: 'openchamber.apk', browser_download_url: 'https://example.com/plain.apk' }],
    };
    const info = await fetchLatestMobileRelease('2.3.3', fetchReturning(JSON.stringify(body)));
    expect(info?.downloadUrl).toBe('https://example.com/plain.apk');
  });

  test('returns null for a malformed tag that would parse as newer', async () => {
    const body = { ...releaseJson(), tag_name: 'v3.' };
    expect(await fetchLatestMobileRelease('2.3.3', fetchReturning(JSON.stringify(body)))).toBeNull();
  });

  test('offers the matching stable release to an installed prerelease', async () => {
    const body = { ...releaseJson(), tag_name: 'v2.3.3' };
    const info = await fetchLatestMobileRelease('2.3.3-beta.1', fetchReturning(JSON.stringify(body)));
    expect(info?.available).toBe(true);
    expect(info?.version).toBe('2.3.3');
  });

  test('offers a newer release to an installed +build version', async () => {
    const info = await fetchLatestMobileRelease('2.3.3+45', fetchRelease());
    expect(info?.available).toBe(true);
    expect(info?.version).toBe('2.4.0');
  });

  test('returns null when the installed version is current or newer', async () => {
    expect(await fetchLatestMobileRelease('2.4.0', fetchRelease())).toBeNull();
    expect(await fetchLatestMobileRelease('2.5.0', fetchRelease())).toBeNull();
  });

  test('returns null on HTTP failure, malformed payloads and network errors', async () => {
    expect(await fetchLatestMobileRelease('2.3.3', fetchReturning('{}', false))).toBeNull();
    expect(await fetchLatestMobileRelease('2.3.3', fetchReturning(JSON.stringify({ tag_name: 42 })))).toBeNull();
    const throwingFetch = async (): Promise<Response> => {
      throw new Error('offline');
    };
    expect(await fetchLatestMobileRelease('2.3.3', throwingFetch)).toBeNull();
  });

  test('passes an abort signal to the release fetch', async () => {
    let seenSignal: AbortSignal | undefined;
    const capturingFetch = async (
      _url: string,
      init: { headers: { Accept: string }; signal: AbortSignal },
    ): Promise<Response> => {
      seenSignal = init.signal;
      return new Response(JSON.stringify(releaseJson()), { status: 200 });
    };
    const info = await fetchLatestMobileRelease('2.3.3', capturingFetch);
    expect(info?.version).toBe('2.4.0');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('a stalled release fetch resolves null at the deadline', async () => {
      const stalledFetch = (
        _url: string,
        init: { headers: { Accept: string }; signal: AbortSignal },
      ): Promise<Response> =>
        // A request that never answers, but like a real fetch it rejects
        // when its signal aborts.
        new Promise<Response>((_resolve, reject) => {
          const { signal } = init;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      const pending = fetchLatestMobileRelease('2.3.3', stalledFetch);
      jest.advanceTimersByTime(MOBILE_RELEASE_FETCH_TIMEOUT_MS);
      expect(await pending).toBeNull();
    });
  });
});
