export const canDriveBrowserPage = (): boolean => (
  Boolean(globalThis.window?.__OPENCHAMBER_ELECTRON__)
);
