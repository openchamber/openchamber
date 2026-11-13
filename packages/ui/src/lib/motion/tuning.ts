import { z } from 'zod';
import { MOTION_SPRING_NAMES, MOTION_SPRINGS, springCssVariables, type MotionSpringName, type SpringSpec } from './springs';

/**
 * Live motion tuning for development builds. The values the dev motion panel
 * sets are written over the stylesheet's defaults on the root element and kept
 * on this device, so a spring can be tried across the app before its numbers
 * go into MOTION_SPRINGS. Production builds never read or write them.
 */

const STORAGE_KEY = 'oc.dev.motionTuning';

export type MotionTuning = {
  springs: Record<MotionSpringName, SpringSpec>;
  /** How long a popup takes to fade out, in ms. */
  popupExitMs: number;
};

export const DEFAULT_MOTION_TUNING: MotionTuning = {
  springs: { ...MOTION_SPRINGS },
  popupExitMs: 110,
};

const springSchema = z.object({ duration: z.number().positive(), bounce: z.number().min(0) });
const storedTuningSchema = z.object({
  springs: z.object({ popup: springSchema, layout: springSchema }).partial().optional(),
  popupExitMs: z.number().min(0).optional(),
});

export const readMotionTuning = (): MotionTuning => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? storedTuningSchema.safeParse(JSON.parse(raw)) : null;
    if (!parsed?.success) return DEFAULT_MOTION_TUNING;
    return {
      springs: { ...DEFAULT_MOTION_TUNING.springs, ...parsed.data.springs },
      popupExitMs: parsed.data.popupExitMs ?? DEFAULT_MOTION_TUNING.popupExitMs,
    };
  } catch {
    return DEFAULT_MOTION_TUNING;
  }
};

/** Writes the tuning over the stylesheet defaults; the defaults come back when nothing is stored. */
export const applyMotionTuning = (tuning: MotionTuning, persist: boolean): void => {
  const root = document.documentElement;
  for (const name of MOTION_SPRING_NAMES) {
    for (const [property, value] of springCssVariables(name, tuning.springs[name])) {
      root.style.setProperty(property, value);
    }
  }
  root.style.setProperty('--oc-motion-popup-exit-duration', `${tuning.popupExitMs}ms`);
  if (persist) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
};

export const resetMotionTuning = (): void => {
  window.localStorage.removeItem(STORAGE_KEY);
  const root = document.documentElement;
  for (const name of MOTION_SPRING_NAMES) {
    for (const [property] of springCssVariables(name, MOTION_SPRINGS[name])) root.style.removeProperty(property);
  }
  root.style.removeProperty('--oc-motion-popup-exit-duration');
};
