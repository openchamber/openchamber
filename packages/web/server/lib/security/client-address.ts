import type { IncomingHttpHeaders } from 'http';
import net from 'net';

import { hasRelayProvenance } from '../relay/provenance.js';

type AddressRequest = {
  ip?: string | undefined;
  headers?: IncomingHttpHeaders | undefined;
  socket?: { remoteAddress?: string | null | undefined } | undefined;
};

const RELAY_RATE_LIMIT_KEY = 'relay';

const isLoopbackAddress = (address: string) => (
  address === '::1'
  || address.startsWith('127.')
);

const withoutMappedPrefix = (address: string) => (
  address.startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address
);

const normalizeAddress = (address: string | null | undefined) => withoutMappedPrefix((address ?? '').trim().toLowerCase());

let trustedProxySource: string | null = null;
let trustedProxies = new net.BlockList();

const configuredProxies = () => {
  const source = process.env.OPENCHAMBER_TRUSTED_PROXIES ?? '';
  if (source === trustedProxySource) return trustedProxies;
  const list = new net.BlockList();
  for (const entry of source.split(',')) {
    const [address = '', prefix] = entry.trim().split('/');
    const normalized = normalizeAddress(address);
    const family = net.isIP(normalized);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(normalized, type);
    } else if (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32)) {
      list.addSubnet(normalized, Number(prefix), type);
    }
  }
  trustedProxySource = source;
  trustedProxies = list;
  return list;
};

const isTrustedProxy = (address: string) => {
  if (isLoopbackAddress(address)) return true;
  const family = net.isIP(address);
  return family !== 0 && configuredProxies().check(address, family === 6 ? 'ipv6' : 'ipv4');
};

const firstHeader = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(',') : value ?? '');

export const rateLimitKey = (req: AddressRequest, noIpFallback: string) => {
  const peer = normalizeAddress(req.socket?.remoteAddress);
  if (!peer) {
    return normalizeAddress(req.ip) || noIpFallback;
  }
  if (isLoopbackAddress(peer) && hasRelayProvenance(req)) {
    return RELAY_RATE_LIMIT_KEY;
  }
  const forwarded = firstHeader(req.headers?.['x-forwarded-for']).split(',').map(normalizeAddress).reverse();
  let client = peer;
  for (const hop of forwarded) {
    if (!isTrustedProxy(client) || !net.isIP(hop)) break;
    client = hop;
  }
  return client;
};
