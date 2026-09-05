import { hasDesktopInvoke, invokeDesktop, isDesktopShell } from '@/lib/desktop';

type InvokeArgs = Record<string, unknown>;
type RelayDevTunnelData = ArrayBuffer | Uint8Array;
type RelayDevTunnelMessage = { type: 'connect' | 'ready' | 'data' | 'close'; data?: RelayDevTunnelData };
type RelayDevTunnelEvent = { connectionId: string; remotePort: number; message: RelayDevTunnelMessage };
type RelayDevTunnelBridge = {
  relayDevTunnelListen?: (handler: (event: RelayDevTunnelEvent) => void) => void;
  relayDevTunnelPost?: (connectionId: string, message: RelayDevTunnelMessage) => void;
};

declare global {
  interface Window {
    __OPENCHAMBER_DESKTOP__?: RelayDevTunnelBridge;
  }
}

const getRelayDevTunnelBridge = (): RelayDevTunnelBridge | null => {
  return globalThis.window?.__OPENCHAMBER_DESKTOP__ ?? null;
};

export const listenForDesktopRelayDevTunnels = (handler: (event: RelayDevTunnelEvent) => void): boolean => {
  const bridge = getRelayDevTunnelBridge();
  if (!bridge?.relayDevTunnelListen) return false;
  bridge.relayDevTunnelListen(handler);
  return true;
};

export const postDesktopRelayDevTunnelMessage = (connectionId: string, message: RelayDevTunnelMessage): void => {
  getRelayDevTunnelBridge()?.relayDevTunnelPost?.(connectionId, message);
};

export const invokeDesktopCommand = async <TValue = unknown>(
  command: string,
  args?: InvokeArgs,
): Promise<TValue> => {
  if (!hasDesktopInvoke()) {
    throw new Error('Desktop runtime is not available');
  }
  return invokeDesktop<TValue>(command, args) as Promise<TValue>;
};

export const startDesktopWindowDrag = async (): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_start_window_drag');
  } catch {
    // ignore
  }
};

export const setDesktopWindowTitle = async (title: string): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_set_window_title', { title });
  } catch {
    // ignore
  }
};

export const setDesktopWindowTheme = async (
  themeMode?: string,
  themeVariant?: string,
): Promise<void> => {
  if (!isDesktopShell()) {
    return;
  }

  try {
    await invokeDesktopCommand('desktop_set_window_theme', { themeMode, themeVariant });
  } catch {
    // ignore
  }
};

export const getDesktopAppVersion = async (): Promise<string | null> => {
  if (!isDesktopShell()) {
    return null;
  }

  try {
    const version = await invokeDesktopCommand('desktop_get_app_version');
    return typeof version === 'string' && version.trim().length > 0 ? version : null;
  } catch {
    return null;
  }
};
