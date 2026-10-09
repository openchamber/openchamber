import React from 'react';

import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const readDesktopRemoteHostActive = (): boolean => isElectronShell() && !isDesktopLocalOriginActive();

/**
 * Whether this desktop window is connected to a remote host instead of its
 * own server. The app's update then updates only the app, while the server
 * the window works with is another machine with its own version.
 */
export const useDesktopRemoteHostActive = (): boolean =>
  React.useSyncExternalStore(subscribeRuntimeEndpointChanged, readDesktopRemoteHostActive, readDesktopRemoteHostActive);
