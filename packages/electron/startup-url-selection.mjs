export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

// The environment can stop the built-in server and point the window at another
// address. Neither shows anywhere else, so a launch that inherited them from a
// terminal or a shortcut looked like a server that failed without a word.
// Only the origin of the address is logged: a path or query may carry a token.
export const describeStartupEnvironmentOverrides = ({ skipLocalServer, serverUrl }) => {
  const lines = [];
  if (skipLocalServer) {
    lines.push('OPENCHAMBER_SKIP_LOCAL_SERVER=1 is set: not starting the built-in server');
  }
  const raw = (serverUrl ?? '').trim();
  if (raw) {
    let origin = '';
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
    } catch {
      // Not a URL: startup ignores it, and the line below says so.
    }
    lines.push(origin
      ? `OPENCHAMBER_SERVER_URL is set: opening ${origin}`
      : 'OPENCHAMBER_SERVER_URL is set but is not an http(s) address: ignoring it');
  }
  return lines;
};

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }) => (
  development !== true || packagedUi === true
);
