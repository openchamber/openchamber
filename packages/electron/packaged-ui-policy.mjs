export const shouldUsePackagedUi = ({
  env = process.env,
  isPackaged = false,
  platform = process.platform,
} = {}) => {
  if (env?.OPENCHAMBER_ELECTRON_LOAD_SERVER_UI === '1') return false;
  if (env?.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1') return true;

  // On Windows, the packaged custom protocol regresses realtime traffic to the
  // loopback server. Serve the same bundled assets over the local HTTP server
  // by default, while keeping the protocol path available for explicit testing.
  if (platform === 'win32') return false;

  return Boolean(isPackaged);
};
