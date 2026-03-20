/**
 * Utility for opening external URLs with Tauri shell support.
 * In desktop runtime, uses tauri.shell.open() for proper system browser handling.
 * Falls back to window.open() for web runtime.
 */

type TauriShell = {
  shell?: {
    open?: (url: string) => Promise<unknown>;
  };
};

/**
 * Opens an external URL in the system browser.
 * In Tauri desktop runtime, uses tauri.shell.open() for proper handling.
 * Falls back to window.open() for web runtime.
 *
 * @param url - The URL to open
 * @returns Promise<boolean> - true if the URL was opened successfully
 */
export const openExternalUrl = async (url: string): Promise<boolean> => {
  const target = url.trim();
  if (!target || typeof window === 'undefined') {
    return false;
  }

  // Check for Tauri runtime
  const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
  if (tauri?.shell?.open) {
    try {
      await tauri.shell.open(target);
      return true;
    } catch {
      // Fall through to window.open
    }
  }

  // Fallback to window.open for web runtime
  try {
    window.open(target, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
};
