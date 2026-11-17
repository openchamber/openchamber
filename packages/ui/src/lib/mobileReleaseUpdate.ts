import { z } from 'zod';
import type { UpdateInfo } from '@/lib/desktop';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

/**
 * The installed Android app checked against this fork's GitHub releases,
 * directly from the app. The update store's mobile check goes through the
 * connected server, so a phone that has not connected yet — or whose server
 * predates the fork's update route — never hears about a new release. This
 * check needs nothing but the app itself and network access to GitHub.
 *
 * Every failure returns null: no network, a rate-limited or malformed
 * answer, and "no newer release" all read the same to the caller, which
 * falls back to the server check.
 */

const LATEST_RELEASE_URL = 'https://api.github.com/repos/developing-today-forks/openchamber/releases/latest';

// One deadline for the whole release fetch, body read included: a stalled
// GitHub answer must settle as null within the bound so the caller can run
// its server fallback instead of wedging in the checking state.
export const MOBILE_RELEASE_FETCH_TIMEOUT_MS = 10_000;

const githubReleaseResponse = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        browser_download_url: z.string(),
      }),
    )
    .optional(),
});

type ReleaseFetch = (
  url: string,
  init: { headers: { Accept: string }; signal: AbortSignal },
) => Promise<Response>;

/** Parsed release version: numeric parts plus whether a prerelease suffix is present ("v2.3.3-beta.1" -> parts [2, 3, 3], prerelease true; a "+build" suffix is ignored). Null when any numeric part is not a plain number. */
function versionParts(version: string): { parts: number[]; prerelease: boolean } | null {
  // Build metadata never affects ordering: "2.3.3+45" is "2.3.3".
  const withoutBuild = version.trim().replace(/^v/, '').split('+')[0];
  const prereleaseIndex = withoutBuild.indexOf('-');
  const core = prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild;
  if (!core) return null;
  const rawParts = core.split('.');
  // Number() alone is too lenient: '' parses as 0, '0x10' as 16, '1e3' as 1000.
  if (rawParts.some((part) => !/^\d+$/.test(part))) return null;
  return { parts: rawParts.map((part) => Number(part)), prerelease: prereleaseIndex >= 0 };
}

/**
 * Compares two release versions: 1 when `left` is newer, -1 when older, 0
 * when equal or when either side is not a plain numeric version (an
 * unparseable version never claims an update).
 */
export function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = versionParts(left);
  const rightVersion = versionParts(right);
  if (!leftVersion || !rightVersion) return 0;
  const length = Math.max(leftVersion.parts.length, rightVersion.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftVersion.parts[index] ?? 0) - (rightVersion.parts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same numeric release: a prerelease is older than the release itself,
  // matching the server copy's pinned semantics.
  if (leftVersion.prerelease !== rightVersion.prerelease) return leftVersion.prerelease ? -1 : 1;
  return 0;
}

/**
 * The newest published release as update info for `currentVersion`, or
 * null when the installed build is current or the answer cannot be used.
 * The download URL names the release's canonical Android APK asset (the
 * asset `mobile-release.yml` uploads), falling back to any APK asset.
 */
export async function fetchLatestMobileRelease(
  currentVersion: string,
  fetchImpl: ReleaseFetch,
): Promise<UpdateInfo | null> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(MOBILE_RELEASE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = githubReleaseResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;

    const version = parsed.data.tag_name.replace(/^v/, '');
    if (compareReleaseVersions(version, currentVersion) <= 0) return null;

    const assets = parsed.data.assets ?? [];
    const apk = assets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name))
      ?? assets.find((asset) => asset.name.toLowerCase().endsWith('.apk'));

    return {
      available: true,
      version,
      currentVersion,
      releaseUrl: parsed.data.html_url,
      downloadUrl: apk?.browser_download_url,
    };
  } catch {
    return null;
  }
}

/**
 * The direct check for the running app: Android Capacitor builds only,
 * compared on the native version the OS reports for the installed APK
 * (not the bundled web UI version). Silent null everywhere else.
 */
export async function checkMobileReleaseUpdate(): Promise<UpdateInfo | null> {
  if (!isCapacitorApp() || getClientPlatform() !== 'android') return null;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const currentVersion = info.version.trim();
    if (!currentVersion) return null;
    return fetchLatestMobileRelease(currentVersion, (url, init) => fetch(url, init));
  } catch {
    return null;
  }
}
