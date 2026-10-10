import { LAYOUT_ANIMATION_MS } from '@/lib/layoutAnimation';
import { useUIStore } from '@/stores/useUIStore';

/**
 * How long the side columns animate open and closed: the session sidebar,
 * the context zones and the work-status card. Zero when the user turned
 * those animations off (Settings › General › Navigation), and then the
 * layout animation they announce ends at once too.
 */
export const useLayoutAnimationMs = (): number => {
  const enabled = useUIStore((state) => state.layoutAnimations);
  return enabled ? LAYOUT_ANIMATION_MS : 0;
};
