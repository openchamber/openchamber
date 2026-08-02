type MobileLandingMode = 'last-session' | 'recents';

type RecentsLandingGateInput = {
  readonly mobileLandingMode: MobileLandingMode;
  readonly isTabletLayout: boolean;
  readonly currentSessionId: string | null | undefined;
  readonly draftOpen: boolean;
  readonly landingDismissed: boolean;
  readonly initialSessionRoutePending: boolean;
};

type LastSessionRestoreGateInput = {
  readonly mobileLandingMode: MobileLandingMode;
  readonly isTabletLayout: boolean;
};

export const shouldShowRecentsLanding = (input: RecentsLandingGateInput): boolean => (
  input.mobileLandingMode === 'recents'
  && !input.isTabletLayout
  && !input.currentSessionId
  && !input.draftOpen
  && !input.landingDismissed
  && !input.initialSessionRoutePending
);

export const shouldBypassLastSessionRestore = (input: LastSessionRestoreGateInput): boolean => (
  input.mobileLandingMode === 'recents' && !input.isTabletLayout
);
