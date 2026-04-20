import React from 'react';
import { ChooserScreen } from './ChooserScreen';
import { LocalSetupScreen } from './LocalSetupScreen';
import { RecoveryScreen } from './RecoveryScreen';
import type { RecoveryVariant } from './DesktopConnectionRecovery';
import { useIsAndroidTwa } from '@/hooks/useIsAndroidTwa';
import { RemoteConnectionForm } from './RemoteConnectionForm';

export type OnboardingScreenMode = 'first-launch' | 'local-setup' | 'recovery';

type OnboardingScreenProps = {
  /** Callback when user goes back from local-setup */
  onBack?: () => void;
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
  /** Screen mode to render */
  mode?: OnboardingScreenMode;
  /** Recovery variant (only used when mode is 'recovery') */
  recoveryVariant?: RecoveryVariant;
  /** Host URL for recovery context */
  recoveryHostUrl?: string;
  /** Host label for recovery context */
  recoveryHostLabel?: string;
  /** Callback when user enters local setup from recovery */
  onEnterLocalSetup?: () => void;
  /** Callback when user wants to switch to remote (first-launch only) */
  onChooseRemote?: () => void;
};

export function OnboardingScreen({
  onBack,
  onCliAvailable,
  mode = 'first-launch',
  recoveryVariant = 'missing-default-host',
  recoveryHostUrl,
  recoveryHostLabel,
  onEnterLocalSetup,
}: OnboardingScreenProps) {
  const [showRecoveryRemoteForm, setShowRecoveryRemoteForm] = React.useState(false);
  const [recoveryEnteredLocalSetup, setRecoveryEnteredLocalSetup] = React.useState(false);
const isAndroidTwa = useIsAndroidTwa();

  // Reset transient recovery subflow state when the flow identity changes, so
  // stale local-setup or remote-form views don't bleed across prop updates.
  React.useEffect(() => {
    setRecoveryEnteredLocalSetup(false);
    setShowRecoveryRemoteForm(false);
  }, [mode, recoveryVariant, recoveryHostUrl, recoveryHostLabel]);

  // Derive the effective mode: recovery → local-setup can fall through to the
  // existing local-setup branch instead of getting stuck behind the early return.
  const effectiveMode = recoveryEnteredLocalSetup ? 'local-setup' : mode;

  // Recovery mode
  if (effectiveMode === 'recovery') {
    return (
      <RecoveryScreen
        variant={recoveryVariant}
        hostUrl={recoveryHostUrl}
        hostLabel={recoveryHostLabel}
        showRemoteForm={showRecoveryRemoteForm}
        onCloseRemoteForm={() => setShowRecoveryRemoteForm(false)}
        onSwitchToLocalFromRemote={() => {
          setShowRecoveryRemoteForm(false);
          setRecoveryEnteredLocalSetup(true);
        }}
        onEnterLocalSetup={() => {
          setRecoveryEnteredLocalSetup(true);
          onEnterLocalSetup?.();
        }}
      />
    );
  }

  // Local-setup mode
  if (effectiveMode === 'local-setup') {
    return (
      <LocalSetupScreen
        onBack={() => {
          if (recoveryEnteredLocalSetup) {
            setRecoveryEnteredLocalSetup(false);
          } else {
            onBack?.();
          }
        }}
        onCliAvailable={onCliAvailable}
        isFromRecovery={recoveryEnteredLocalSetup}
        onSwitchToRemote={() => setShowRecoveryRemoteForm(true)}
      />
    );
  }

// First-launch mode (default)
if (isAndroidTwa) {
  return (
    <RemoteConnectionForm
      onBack={() => {}}
      showBackButton={false}
    />
  );
}
return (
  <ChooserScreen
    onCliAvailable={onCliAvailable}
  />
);
}
