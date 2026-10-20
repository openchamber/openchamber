import { z } from 'zod';

export const mobileScreenAwakeModeSchema = z.enum(['off', 'working', 'always']).catch('off');
export type MobileScreenAwakeMode = z.infer<typeof mobileScreenAwakeModeSchema>;
