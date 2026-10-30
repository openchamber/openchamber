/**
 * Where the desktop app, or a server installed from npm, takes its updates
 * from: the releases, or Canary, the nightly build of the latest code. Picking
 * Canary makes the next update replace the install with the Canary build, and
 * later checks follow Canary until the person goes back to Stable. The desktop
 * main process stores its choice (`desktopUpdateChannel`) and points its
 * updater at the channel's feed; the npm server stores its own
 * (`serverUpdateChannel`) and reads the channel's npm dist-tag.
 */
export type UpdateChannel = 'stable' | 'canary';

export const isUpdateChannel = (value: string | null | undefined): value is UpdateChannel => (
  value === 'stable' || value === 'canary'
);

type CanaryVersion = {
  /** The release the build leads to, `2.5.4` for `2.5.4-canary.20261030.123`. */
  release: string;
  /** The day the build was made, at UTC midnight. */
  builtOn: Date;
};

const CANARY_VERSION_RE = /^v?(\d+\.\d+\.\d+)-canary\.(\d{4})(\d{2})(\d{2})(?:\.\d+)?$/;

/** The parts of a Canary build's version, or null for a release version. */
export const parseCanaryVersion = (version: string | null | undefined): CanaryVersion | null => {
  const match = CANARY_VERSION_RE.exec(version ?? '');
  if (!match) return null;
  const [, release, year, month, day] = match;
  return { release, builtOn: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))) };
};

/** `30 Oct` in the given locale, for the day a Canary build was made. */
export const formatCanaryBuildDate = (builtOn: Date, locale: string): string => (
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(builtOn)
);
