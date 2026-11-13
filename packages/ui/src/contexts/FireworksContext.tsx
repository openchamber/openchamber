import React from 'react';
import { FireworksAnimation } from '@/components/ui/FireworksAnimation';
import type { CelebrationOptions } from '@/components/ui/fireworksShows';
import { useFireworks } from '@/hooks/useFireworks';

interface FireworksContextValue {
  triggerFireworks: (options?: CelebrationOptions) => void;
  dismissFireworks: () => void;
}

const FireworksContext = React.createContext<FireworksContextValue | undefined>(undefined);

// A surface mounted without the overlay (Mini Chat, a test) celebrates nothing.
const NO_FIREWORKS: FireworksContextValue = { triggerFireworks: () => {}, dismissFireworks: () => {} };

export const FireworksProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isActive, burstKey, show, triggerFireworks, dismissFireworks } = useFireworks();

  const value = React.useMemo<FireworksContextValue>(
    () => ({ triggerFireworks, dismissFireworks }),
    [triggerFireworks, dismissFireworks]
  );

  return (
    <FireworksContext.Provider value={value}>
      {children}
      <FireworksAnimation isActive={isActive} burstKey={burstKey} show={show} />
    </FireworksContext.Provider>
  );
};

// oxlint-disable-next-line react/only-export-components
export const useFireworksCelebration = (): FireworksContextValue => React.useContext(FireworksContext) ?? NO_FIREWORKS;
