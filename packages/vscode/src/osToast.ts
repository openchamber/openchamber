import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * OS-level toast delivery (Windows Action Center).
 *
 * `vscode.window.show*Message` only renders inside the VS Code window and can
 * never reach the OS notification center, so on Windows the host first tries
 * the vendored SnoreToast helper (`vendor/snoreToast/`, LGPL-3.0, see
 * ATTRIBUTION.md). Any failure — missing binary, spawn error, non-zero
 * exit, non-Windows platform — returns false and the caller falls back to
 * the in-window `show*Message` path. Display-only in v1 (no click actions).
 */

export const SNORE_TOAST_APP_ID = 'OpenChamber.OpenChamber';

export const resolveSnoreToastPath = (
  extensionPath: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null => {
  if (!extensionPath || platform !== 'win32') return null;
  // arm64 Windows runs x64 binaries via emulation; ia32 gets the x86 build.
  const suffix = arch === 'x86' || arch === 'ia32' ? 'x86' : 'x64';
  const exe = path.join(extensionPath, 'vendor', 'snoreToast', `snoretoast-${suffix}.exe`);
  try {
    if (!fs.existsSync(exe)) return null;
  } catch {
    return null;
  }
  return exe;
};

const resolveToastIcon = (extensionPath: string): string | null => {
  const icon = path.join(extensionPath, 'assets', 'app-icon.png');
  try {
    if (fs.existsSync(icon)) return icon;
  } catch {
    // Icon is decorative; never block the toast on it.
  }
  return null;
};

/** Fire-and-forget submit; true once the helper process has spawned. */
export const tryShowOsToast = async (args: {
  title?: unknown;
  body?: unknown;
  extensionPath?: unknown;
}): Promise<boolean> => {
  const extensionPath = typeof args.extensionPath === 'string' ? args.extensionPath : '';
  const helper = resolveSnoreToastPath(extensionPath);
  if (!helper) return false;

  const title = typeof args.title === 'string' && args.title.trim().length > 0
    ? args.title.trim()
    : 'OpenChamber';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!title && !body) return false;

  // NB: the AppId flag is `-appid` (no `-a` shorthand exists; unknown flags
  // make SnoreToast exit -1 before displaying anything).
  const cli = ['-t', title, '-m', body, '-appid', SNORE_TOAST_APP_ID];
  const icon = resolveToastIcon(extensionPath);
  if (icon) cli.push('-p', icon);

  // SnoreToast stays resident until the toast is dismissed and exits with the
  // user-action code (0-5), so waiting for exit can never report delivery.
  // Spawn detached and treat a successful spawn as submitted; the helper
  // outlives us and exits on its own.
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper, cli, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
};
