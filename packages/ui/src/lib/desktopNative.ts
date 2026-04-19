import { isTauriShell } from '@/lib/desktop';

type InvokeArgs = Record<string, unknown>;

const isElectronDesktop = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as { __OPENCHAMBER_ELECTRON__?: unknown }).__OPENCHAMBER_ELECTRON__);
};

const getInvoke = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  const tauri = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: InvokeArgs) => Promise<unknown> } };
  }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
};

export const invokeDesktopCommand = async <TValue = unknown>(
  command: string,
  args?: InvokeArgs,
): Promise<TValue> => {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error('Desktop runtime is not available');
  }
  return invoke(command, args) as Promise<TValue>;
};

export const startDesktopWindowDrag = async (): Promise<void> => {
  if (!isTauriShell()) {
    return;
  }

  try {
    if (isElectronDesktop()) {
      await invokeDesktopCommand('desktop_start_window_drag');
      return;
    }

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch {
    // ignore
  }
};

export const isDesktopWindowFullscreen = async (): Promise<boolean> => {
  if (!isTauriShell()) {
    return false;
  }

  try {
    if (!isElectronDesktop()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return await getCurrentWindow().isFullscreen();
    }

    return Boolean(await invokeDesktopCommand('desktop_is_window_fullscreen'));
  } catch {
    return false;
  }
};

export const onDesktopWindowResized = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
};

export const setDesktopWindowTitle = async (title: string): Promise<void> => {
  if (!isTauriShell()) {
    return;
  }

  try {
    if (!isElectronDesktop()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTitle(title);
      return;
    }

    await invokeDesktopCommand('desktop_set_window_title', { title });
  } catch {
    // ignore
  }
};

export const setDesktopWindowTheme = async (
  themeMode?: string,
  themeVariant?: string,
): Promise<void> => {
  if (!isTauriShell()) {
    return;
  }

  try {
    if (!isElectronDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('desktop_set_window_theme', { themeMode, themeVariant });
      return;
    }

    await invokeDesktopCommand('desktop_set_window_theme', { themeMode, themeVariant });
  } catch {
    // ignore
  }
};

export const getDesktopAppVersion = async (): Promise<string | null> => {
  if (!isTauriShell()) {
    return null;
  }

  try {
    if (!isElectronDesktop()) {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    }

    const version = await invokeDesktopCommand('desktop_get_app_version');
    return typeof version === 'string' && version.trim().length > 0 ? version : null;
  } catch {
    return null;
  }
};

export const readDesktopFile = async (
  path: string,
): Promise<{ mime: string; base64: string; size?: number }> => {
  return invokeDesktopCommand('desktop_read_file', { path });
};

export const readDesktopFileAsDataUrl = async (path: string): Promise<string> => {
  const result = await readDesktopFile(path);
  return `data:${result.mime || 'application/octet-stream'};base64,${result.base64}`;
};

export const listenDesktopNativeDragDrop = async (
  handler: (event: unknown) => void,
): Promise<(() => void) | null> => {
  if (!isTauriShell() || typeof window === 'undefined') {
    return null;
  }

  if (isElectronDesktop()) {
    return null;
  }

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const webviewWindow = getCurrentWebviewWindow();
    return await webviewWindow.onDragDropEvent(handler as never);
  } catch {
    return null;
  }
};
