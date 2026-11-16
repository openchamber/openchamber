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

/**
 * The opposite of `useKnowledgeRevealClass`: what makes room for the row's
 * actions, such as a plan's date, fades out while they show. The actions sit
 * over it, so the row keeps no empty column for them at rest. Touch screens
 * show both side by side.
 */
export const useKnowledgeYieldClass = (): string => {
  const isMobile = useUIStore((state) => state.isMobile);
  return isMobile
    ? ''
    : 'group-hover/knowledge:opacity-0 group-has-[:focus-visible]/knowledge:opacity-0 group-has-[[aria-expanded=true]]/knowledge:opacity-0';
};
