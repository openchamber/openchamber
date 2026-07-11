import type { RuntimeAPIs } from '@/lib/api/types';

let registeredRuntimeAPIs: RuntimeAPIs | null = null;

export const registerRuntimeAPIs = (apis: RuntimeAPIs | null): void => {
  registeredRuntimeAPIs = apis;
};

export const getRegisteredRuntimeAPIs = (): RuntimeAPIs | null => {
  if (registeredRuntimeAPIs) {
    return registeredRuntimeAPIs;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  return (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs })
    .__OPENCHAMBER_RUNTIME_APIS__ ?? null;
};
