import type { SidebarSectionEntry } from '@/lib/sidebarSections';
import { useSessionDisplayStore, type ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { useSidebarSectionsUiStore } from '../sections/sectionActions';

const filtersByActivity = (section: SidebarSectionEntry): boolean => section.kind === 'custom' && section.filter.activity !== 'any';

export const useSidebarReadsActivityTime = (searchActive: boolean, projectSortOrder: ProjectSortOrder): boolean => {
  const sectionsFilterByActivity = useSessionDisplayStore((state) => state.sections.some(filtersByActivity));
  const draftFiltersByActivity = useSidebarSectionsUiStore((state) => (state.draft ? filtersByActivity(state.draft) : false));
  return searchActive || projectSortOrder === 'recent' || sectionsFilterByActivity || draftFiltersByActivity;
};
