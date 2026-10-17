import { useUIStore } from '@/stores/useUIStore';

// Whether the isolated-spaces feature is released to users. The feature is built, on local
// Docker, and stays hidden until the maintainers decide to show it (decision 17 in
// packages/web/server/lib/spaces/DOCUMENTATION.md). Flip this to show it; nothing else needs to
// change.
const ISOLATED_SPACES_RELEASED = false;

// Whether Settings shows the "Isolated spaces" page and its search entries: always once the
// feature is released, and before that while the `isolatedSpacesEnabled` key in settings.json is
// on, so the people building the feature reach the places, the image and the idle stop. Read when
// Settings computes its pages, so turning the switch off there keeps the page until Settings opens
// again.
export const isIsolatedSpacesPageVisible = (): boolean =>
  ISOLATED_SPACES_RELEASED || useUIStore.getState().isolatedSpacesEnabled;
