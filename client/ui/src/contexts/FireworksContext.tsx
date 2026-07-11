import React from 'react';
import { FireworksAnimation } from '@/components/ui/FireworksAnimation';
import { useFireworks } from '@/hooks/useFireworks';

interface FireworksContextValue {
  triggerFireworks: () => void;
  dismissFireworks: () => void;
}

const FireworksContext = React.createContext<FireworksContextValue | undefined>(undefined);

export const FireworksProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isActive, burstKey, triggerFireworks, dismissFireworks } = useFireworks();

  const value = React.useMemo<FireworksContextValue>(
    () => ({ triggerFireworks, dismissFireworks }),
    [triggerFireworks, dismissFireworks]
  );

  return (
    <FireworksContext.Provider value={value}>
      {children}
      <FireworksAnimation isActive={isActive} burstKey={burstKey} />
    </FireworksContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useFireworksCelebration = (): FireworksContextValue => {
  const context = React.useContext(FireworksContext);
  if (!context) {
    throw new Error('useFireworksCelebration must be used within FireworksProvider');
  }
  return context;
};
