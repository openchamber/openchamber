import { useUIStore } from '@/stores/useUIStore';

export const KNOWLEDGE_ICON_BUTTON_CLASS = 'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';

export const useKnowledgeRevealClass = (): string => {
  const isMobile = useUIStore((state) => state.isMobile);
  return isMobile
    ? ''
    : 'opacity-0 group-hover/knowledge:opacity-100 group-has-[:focus-visible]/knowledge:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100';
};

export const useKnowledgeYieldClass = (): string => {
  const isMobile = useUIStore((state) => state.isMobile);
  return isMobile
    ? ''
    : 'group-hover/knowledge:opacity-0 group-has-[:focus-visible]/knowledge:opacity-0 group-has-[[aria-expanded=true]]/knowledge:opacity-0';
};
