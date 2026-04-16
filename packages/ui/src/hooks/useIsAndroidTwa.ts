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
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'true') return true;
    return checkBridge();
  });

  React.useEffect(() => {
    if (checkBridge()) {
      localStorage.setItem(STORAGE_KEY, 'true');
      setIsAndroidTwa(true);
      return;
    }

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
