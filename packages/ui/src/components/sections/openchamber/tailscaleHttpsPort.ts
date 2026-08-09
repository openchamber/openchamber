export const TAILSCALE_FUNNEL_HTTPS_PORTS = [443, 8443, 10000] as const;

export const parseTailscaleHttpsPort = (value: unknown): number | null => {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};

export const tailscaleHttpsPortFor = (
  provider: string,
  mode: string,
  value: unknown,
): number | undefined => {
  if (provider !== 'tailscale') return undefined;

  const port = parseTailscaleHttpsPort(value) ?? 443;
  return mode === 'quick' && !TAILSCALE_FUNNEL_HTTPS_PORTS.some((supportedPort) => supportedPort === port)
    ? 443
    : port;
};
