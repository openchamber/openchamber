/**
 * `@/stores/useUIStore` inside a shared page: the few settings the bundled
 * components read, at the defaults a reader without OpenChamber has. The
 * calendar follows the reader's locale.
 */
// The bundle runs only in the shared page, where a window always exists.
const coarsePhone = window.matchMedia('(pointer: coarse) and (max-width: 640px)').matches;

const state = {
  isMobile: coarsePhone,
  timeFormatPreference: 'auto',
  weekStartPreference: 'auto',
};

type ShareUIState = typeof state;

export function useUIStore<T>(selector: (current: ShareUIState) => T): T {
  return selector(state);
}

useUIStore.getState = (): ShareUIState => state;
