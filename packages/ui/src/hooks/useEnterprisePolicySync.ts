/**
 * Keeps the enterprise policy store current: one read per runtime. The policy
 * changes only when an administrator edits the machine's policy file or the
 * server's environment, so there is no live channel to follow.
 */
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
