import { LAYOUT_ANIMATION_MS } from '@/lib/layoutAnimation';
import { useUIStore } from '@/stores/useUIStore';

export const useLayoutAnimationMs = (): number => {
  const enabled = useUIStore((state) => state.layoutAnimations);
  return enabled ? LAYOUT_ANIMATION_MS : 0;
};
