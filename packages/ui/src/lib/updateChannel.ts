export type UpdateChannel = 'stable' | 'canary';

export const isUpdateChannel = (value: string | null | undefined): value is UpdateChannel => (
  value === 'stable' || value === 'canary'
);

type CanaryVersion = {
  release: string;
  builtOn: Date;
  build: number | null;
};

const CANARY_VERSION_RE = /^v?(\d+\.\d+\.\d+)-canary\.(\d{4})(\d{2})(\d{2})(?:\.(\d+))?$/;

export const parseCanaryVersion = (version: string | null | undefined): CanaryVersion | null => {
  const match = CANARY_VERSION_RE.exec(version ?? '');
  if (!match) return null;
  const [, release, year, month, day, build] = match;
  return {
    release,
    builtOn: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
    build: build ? Number(build) : null,
  };
};

export const formatCanaryBuildDate = (builtOn: Date, locale: string): string => (
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(builtOn)
);

export const formatCanaryBuild = (canary: CanaryVersion, locale: string, beside?: CanaryVersion | null): string => {
  const date = formatCanaryBuildDate(canary.builtOn, locale);
  const sameDay = beside != null
    && beside.builtOn.getTime() === canary.builtOn.getTime()
    && beside.build !== canary.build;
  return sameDay && canary.build !== null ? `${date} #${canary.build}` : date;
};
