import { z } from 'zod';

const capacitySchema = z.object({
  totalBytes: z.number().finite().positive(),
  availableBytes: z.number().finite().nonnegative(),
}).refine((value) => value.availableBytes <= value.totalBytes);

export type Capacity = z.infer<typeof capacitySchema>;

export const parseCapacity = (body: string): Capacity => capacitySchema.parse(JSON.parse(body));

export const formatBytes = (bytes: number, locale: string): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
};
