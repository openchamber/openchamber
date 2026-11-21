
import React from 'react';

import { getCurrentIntlLocale } from '@/lib/i18n';
import { readSpaceDisk, type SpaceDisk } from './spaces-api';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export const formatDiskSize = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const number = new Intl.NumberFormat(getCurrentIntlLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${number} ${SIZE_UNITS[unit]}`;
};

const reads = new Map<string, Promise<SpaceDisk>>();
const readShared = (placeId: string): Promise<SpaceDisk> => {
  const current = reads.get(placeId);
  if (current) return current;
  const read = readSpaceDisk(placeId).finally(() => reads.delete(placeId));
  reads.set(placeId, read);
  return read;
};

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
