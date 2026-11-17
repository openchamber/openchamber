import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** The sections of the Routing page: one tab each, or all on one page. */
export type RoutingTab = 'auto' | 'categories' | 'rules' | 'pools' | 'plans';

/** Search targets that live outside the Auto section. Every other routing target sits in Auto. */
const SEARCH_TARGET_TABS = new Map<string, RoutingTab>([
  ['routing.add-category', 'categories'],
  ['routing.pools-advanced', 'pools'],
  ['routing.pools-targets', 'pools'],
  ['routing.pools-tuning', 'pools'],
  ['routing.pools-schedules', 'pools'],
  ['pools.add-pool', 'pools'],
]);

/** The tab a Settings search result opens, or null for a result outside the Routing page. */
export const routingTabForSearchTarget = (id: string): RoutingTab | null => {
  // routing.token moved to Providers > Classification (#1762); the
  // routing. prefix fallback must not drag it back to the Routing page.
  if (id === 'routing.token') return null;
  const tab = SEARCH_TARGET_TABS.get(id);
  if (tab) return tab;
  return id.startsWith('routing.') ? 'auto' : null;
};

type RoutingPageView = {
  tab: RoutingTab;
  setTab: (tab: RoutingTab) => void;
  /** Every section on one scrolling page; the tabs then jump to their section. */
  showAllOnOnePage: boolean;
  setShowAllOnOnePage: (showAll: boolean) => void;
};

/** Which sections the Routing page shows. The tab is for this session; the all-on-one-page choice is kept. */
export const useRoutingPageViewStore = create<RoutingPageView>()(
  persist(
    (set) => ({
      tab: 'auto',
      setTab: (tab) => set({ tab }),
      showAllOnOnePage: false,
      setShowAllOnOnePage: (showAllOnOnePage) => set({ showAllOnOnePage }),
    }),
    {
      name: 'routing-page-view',
      version: 1,
      partialize: (state) => ({ showAllOnOnePage: state.showAllOnOnePage }),
    },
  ),
);
