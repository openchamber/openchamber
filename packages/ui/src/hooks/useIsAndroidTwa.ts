import React from 'react';

const STORAGE_KEY = 'openchamber:isAndroidTwa';

type AndroidNotificationBridge = {
  getServerUrl?: () => string;
  openAppSettings?: () => void;
  getPermission?: () => string;
  showNotification?: (title: string, body: string) => void;
  requestPermission?: (callbackId: string) => void;
  openNotificationSettings?: () => void;
};

declare global {
  interface Window {
    AndroidNotificationBridge?: AndroidNotificationBridge;
  }
}

function checkBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.AndroidNotificationBridge?.getServerUrl === 'function';
}

/**
 * Detects whether the app is running inside an Android TWA/WebView shell.
 *
 * Detection strategy:
 * 1. On mount, check for `AndroidNotificationBridge.getServerUrl` (injected by the native shell).
 * 2. Listen for the `notificationbridgeinstalled` DOM event (dispatched by the bridge JS).
 * 3. Persist the result in localStorage so page reloads don't flash the wrong state.
 */
export const useIsAndroidTwa = (): boolean => {
  const [isAndroidTwa, setIsAndroidTwa] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    // Only trust localStorage if the bridge is actually present in this runtime.
    // Chrome and TWA share localStorage for the same origin, so a stale 'true'
    // from a prior TWA session would cause Android-specific UI to flash in Chrome.
    if (checkBridge()) {
      localStorage.setItem(STORAGE_KEY, 'true');
      return true;
    }
    // Clear any stale flag from a prior TWA session.
    localStorage.removeItem(STORAGE_KEY);
    return false;
  });

  React.useEffect(() => {
    if (checkBridge()) {
      localStorage.setItem(STORAGE_KEY, 'true');
      setIsAndroidTwa(true);
      return;
    }

    // Clear stale flag from a prior TWA session (Chrome and TWA share localStorage for the same origin).
    localStorage.removeItem(STORAGE_KEY);
    setIsAndroidTwa(false);

    const handleBridgeInstalled = () => {
      if (checkBridge()) {
        localStorage.setItem(STORAGE_KEY, 'true');
        setIsAndroidTwa(true);
      }
    };

    window.addEventListener('notificationbridgeinstalled', handleBridgeInstalled);
    return () => {
      window.removeEventListener('notificationbridgeinstalled', handleBridgeInstalled);
    };
  }, []);

  return isAndroidTwa;
};
