// Only the embedded managed server has already passed this app's CLI preflight
// checks. Reuse an in-flight preflight without waiting for server health.
// External servers and HMR backends need a fresh check.
export const canReuseManagedOpenCodePreflight = ({ apiBaseUrl, localOrigin, server }) => {
  if (!server || !localOrigin) return false;
  try {
    const target = new URL(apiBaseUrl);
    const local = new URL(localOrigin);
    if (target.origin !== local.origin || target.pathname !== '/' || target.search || target.hash) return false;
  } catch {
    return false;
  }
  return server.getManagedOpenCodePreflight();
};
