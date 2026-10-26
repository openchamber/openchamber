import { useUIStore } from '@/stores/useUIStore';

/** Icon buttons in rows and composers: colour change on hover, no fill. */
export const KNOWLEDGE_ICON_BUTTON_CLASS = 'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Every row in the panel carries the same actions in the same place: at most
 * one direct toggle (pin, send), then a menu with the rest. Rows show them on
 * hover or keyboard focus so a list of ten notes is not a column of twenty
 * icons. Touch screens have no hover, so there they always show.
 *
 * The row that reveals them is marked with `group/knowledge`.
 */
export const useKnowledgeRevealClass = (): string => {
  const isMobile = useUIStore((state) => state.isMobile);
  return isMobile
    ? ''
    : 'opacity-0 group-hover/knowledge:opacity-100 group-has-[:focus-visible]/knowledge:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100';
};
