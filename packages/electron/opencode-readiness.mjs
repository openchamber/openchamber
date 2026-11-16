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
