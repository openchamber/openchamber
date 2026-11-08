// The disk spaces take, as the screens that list them show it.

import React from 'react';

import { getCurrentIntlLocale } from '@/lib/i18n';
import { readSpaceDisk, type SpaceDisk } from './spaces-api';

// Decimal units, as Docker and the Mac's own disk tools count; only the number is localised.
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export const formatDiskSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const number = new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  // A no-break space, so a narrow screen never puts the unit alone on the next line.
  return `${number} ${SIZE_UNITS[unit]}`;
};

// One read per place at a time: the rows of one list that mount together share it.
const reads = new Map<string, Promise<SpaceDisk>>();
const readShared = (placeId: string): Promise<SpaceDisk> => {
  const current = reads.get(placeId);
  if (current) return current;
  const read = readSpaceDisk(placeId).finally(() => reads.delete(placeId));
  reads.set(placeId, read);
  return read;
};

/**
 * What a space's own volumes take on its place, read when the row mounts; null until known, and
 * when the place cannot say (out of reach, a host before it was counted). Not live: a list reads
 * it again when it opens.
 */
export const useSpaceDiskBytes = (placeId: string, spaceId: string): number | null => {
  const [bytes, setBytes] = React.useState<number | null>(null);
  React.useEffect(() => {
    let live = true;
    readShared(placeId).then(
      (disk) => { if (live) setBytes(disk.bytesBySpace[spaceId] ?? null); },
      () => { if (live) setBytes(null); },
    );
    return () => { live = false; };
  }, [placeId, spaceId]);
  return bytes;
};
