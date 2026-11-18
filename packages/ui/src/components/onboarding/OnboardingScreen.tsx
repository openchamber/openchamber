import React from 'react';
import { ChooserScreen } from './ChooserScreen';
import { LocalSetupScreen } from './LocalSetupScreen';
import { RecoveryScreen } from './RecoveryScreen';
import type { RecoveryVariant } from './DesktopConnectionRecovery';

type OnboardingScreenMode = 'first-launch' | 'local-setup' | 'recovery';

type OnboardingScreenProps = {
  onBack?: () => void;
  onCliAvailable?: () => void;
  mode?: OnboardingScreenMode;
  recoveryVariant?: RecoveryVariant;
  recoveryHostUrl?: string;
  recoveryHostLabel?: string;
  recoveryHostId?: string;
  onEnterLocalSetup?: () => void;
  onChooseRemote?: () => void;
  localAvailable?: boolean;
};

export function OnboardingScreen({
  onBack,
  onCliAvailable,
  mode = 'first-launch',
  recoveryVariant = 'missing-default-host',
  recoveryHostUrl,
  recoveryHostLabel,
  recoveryHostId,
  onEnterLocalSetup,
  localAvailable = true,
}: OnboardingScreenProps) {
  const [showRecoveryRemoteForm, setShowRecoveryRemoteForm] = React.useState(false);
  const [recoveryEnteredLocalSetup, setRecoveryEnteredLocalSetup] = React.useState(false);

  React.useEffect(() => {
    setRecoveryEnteredLocalSetup(false);
    setShowRecoveryRemoteForm(false);
  }, [mode, recoveryVariant, recoveryHostUrl, recoveryHostLabel]);

  const effectiveMode = recoveryEnteredLocalSetup ? 'local-setup' : mode;

  if (effectiveMode === 'recovery') {
    return (
      <RecoveryScreen
        variant={recoveryVariant}
        hostUrl={recoveryHostUrl}
        hostLabel={recoveryHostLabel}
        hostId={recoveryHostId}
        onChooseRemote={() => setShowRecoveryRemoteForm(true)}
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
        localAvailable={localAvailable}
      />
    );
  }

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

  return (
    <ChooserScreen
      onCliAvailable={onCliAvailable}
      localAvailable={localAvailable}
    />
  );
}
