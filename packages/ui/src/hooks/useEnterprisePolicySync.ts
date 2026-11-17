import React from 'react';

import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';

export const useEnterprisePolicySync = (): void => {
  React.useEffect(() => {
    const { load, resetForRuntime } = useEnterprisePolicyStore.getState();
    void load();
    return subscribeRuntimeEndpointChanged(() => {
      resetForRuntime();
      void load();
    });
  }, []);
};
