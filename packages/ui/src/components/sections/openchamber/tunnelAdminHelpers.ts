export const resolveTunnelAdminCapability = (canAdminister: unknown): boolean | null => {
  if (canAdminister === true) return true;
  if (canAdminister === false) return false;
  return null;
};

export const isLocked403Error = (status: number, errorData: unknown): boolean => {
  if (status !== 403) return false;
  if (!errorData || typeof errorData !== 'object') return false;
  const data = errorData as Record<string, unknown>;
  return data.error === 'Tunnel administration requires host access.';
};

export const resolveTunnelActiveState = (active: unknown): boolean => {
  return active === true;
};
