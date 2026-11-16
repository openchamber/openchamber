import React from 'react';

import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const readDesktopRemoteHostActive = (): boolean => isElectronShell() && !isDesktopLocalOriginActive();

export const useDesktopRemoteHostActive = (): boolean =>
  React.useSyncExternalStore(subscribeRuntimeEndpointChanged, readDesktopRemoteHostActive, readDesktopRemoteHostActive);
