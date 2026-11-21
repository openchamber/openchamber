type ElectronRuntimeGlobal = {
  runtime?: string;
  arch?: string;
  trayEnabled?: boolean;
  nativeFrame?: boolean;
  transparentWindow?: boolean;
};

export const getElectronRuntime = (): ElectronRuntimeGlobal | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __OPENCHAMBER_ELECTRON__?: ElectronRuntimeGlobal }).__OPENCHAMBER_ELECTRON__ ?? null;
};

export const isElectronShell = (): boolean => getElectronRuntime()?.runtime === 'electron';

export const isDesktopTransparentWindow = (): boolean => getElectronRuntime()?.transparentWindow === true;
