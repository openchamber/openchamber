export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export const SHELL_DEFAULT = IS_WIN ? 'powershell.exe' : (process.env.SHELL ?? 'bash');

export const EOL = IS_WIN ? '\r\n' : '\n';

export const IS_WSL = IS_LINUX
  && (process.env.WSL_DISTRO_NAME != null || process.env.WSLENV != null);

export const IS_CONTAINER = process.env.container != null
  || process.env.KUBERNETES_SERVICE_HOST != null;

export const RUNTIME = typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';
