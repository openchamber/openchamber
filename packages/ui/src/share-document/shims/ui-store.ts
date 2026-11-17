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
