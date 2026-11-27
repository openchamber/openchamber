import { create } from 'zustand';

import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type ReferencePreviewDisplaySettings = {
  referencePreviewNewestFirst: boolean;
  referencePreviewCollapseDescription: boolean;
};

export const DEFAULT_REFERENCE_PREVIEW_DISPLAY: ReferencePreviewDisplaySettings = {
  referencePreviewNewestFirst: false,
  referencePreviewCollapseDescription: false,
};

type ReferencePreviewDisplayState = ReferencePreviewDisplaySettings & { runtimeKey: string | null };

export const useReferencePreviewDisplayStore = create<ReferencePreviewDisplayState>()(() => ({
  ...DEFAULT_REFERENCE_PREVIEW_DISPLAY,
  runtimeKey: null,
}));

export const selectReferencePreviewDisplay = (state: ReferencePreviewDisplayState): ReferencePreviewDisplaySettings => (
  state.runtimeKey === getRuntimeKey() ? state : DEFAULT_REFERENCE_PREVIEW_DISPLAY
);

export const readReferencePreviewDisplay = (): ReferencePreviewDisplaySettings => (
  selectReferencePreviewDisplay(useReferencePreviewDisplayStore.getState())
);

export const writeReferencePreviewDisplay = (changes: Partial<ReferencePreviewDisplaySettings>): void => {
  useReferencePreviewDisplayStore.setState((state) => ({
    ...selectReferencePreviewDisplay(state),
    ...changes,
    runtimeKey: getRuntimeKey(),
  }));
};

subscribeRuntimeEndpointChanged(({ runtimeKey, previousRuntimeKey }) => {
  if (runtimeKey === previousRuntimeKey) return;
  useReferencePreviewDisplayStore.setState({ ...DEFAULT_REFERENCE_PREVIEW_DISPLAY, runtimeKey: null });
});
