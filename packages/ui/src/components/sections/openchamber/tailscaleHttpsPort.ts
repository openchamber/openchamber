export const TAILSCALE_FUNNEL_HTTPS_PORTS = [443, 8443, 10000] as const;

export const parseTailscaleHttpsPort = (
  value: number | string | null | undefined,
): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535 ? numeric : null;
};

export const tailscaleHttpsPortFor = (
  provider: string,
  mode: string,
  value: number | string | null | undefined,
): number | undefined => {
  if (provider !== 'tailscale') return undefined;

  const port = parseTailscaleHttpsPort(value) ?? 443;
  return mode === 'quick' && !TAILSCALE_FUNNEL_HTTPS_PORTS.some((supportedPort) => supportedPort === port)
    ? 443
    : port;
};
