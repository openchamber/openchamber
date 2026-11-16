
import type { SpaceDisk } from '@/lib/spaces/spaces-api';

const IMAGE_PULL_REFRESH_MS = 3_000;
export const IMAGE_SETTLE_REFRESH_MS = 1_000;
const IMAGE_SETTLE_READS = 5;

export const nextDiskReadDelay = (disk: Pick<SpaceDisk, 'imagePulling' | 'imageBytes'>, settleReads: number): number | null => {
  if (disk.imagePulling) return IMAGE_PULL_REFRESH_MS;
  if (disk.imageBytes === 0 && settleReads < IMAGE_SETTLE_READS) return IMAGE_SETTLE_REFRESH_MS;
  return null;
};
