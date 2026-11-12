import { z } from 'zod';

// Front-door settings mirroring owns this field. A bad entry invalidates the
// whole policy so a partially readable refusal list cannot start a browser.
export const serverBrowserOriginsSchema = z.array(z.string().refine((value) => {
  try {
    const url = new URL(value);
    return value.trim() === value && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) origin')).max(256);

export const serverBrowserOrigins = ({ settingsOrigins = [], port, host, addresses = [] }) => {
  const origins = serverBrowserOriginsSchema.parse(settingsOrigins);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OpenChamber listening port is unavailable');
  const hosts = ['localhost', '127.0.0.1', '::1', host, ...addresses].filter(Boolean);
  const listening = hosts.map((address) => {
    const hostname = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
    return new URL(`http://${hostname}:${port}`).origin;
  });
  return [...new Set([...origins.map((origin) => new URL(origin).origin), ...listening])];
};
