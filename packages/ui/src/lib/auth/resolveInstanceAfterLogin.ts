const isLikelyLocalHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local')) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (octets[0] === 127 || octets[0] === 10) {
    return true;
  }
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }
  if (octets[0] === 169 && octets[1] === 254) {
    return true;
  }
  return false;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 127;
};

const normalizeLocalOriginForCurrentRuntime = (parsed: URL): URL => {
  if (typeof window === 'undefined') {
    return parsed;
  }
  const currentOrigin = window.location?.origin;
  if (typeof currentOrigin !== 'string' || currentOrigin.trim().length === 0) {
    return parsed;
  }
  let runtimeUrl: URL;
  try {
    runtimeUrl = new URL(currentOrigin);
  } catch {
    return parsed;
  }
  if ((runtimeUrl.protocol !== 'http:' && runtimeUrl.protocol !== 'https:') || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return parsed;
  }

  const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const runtimePort = runtimeUrl.port || (runtimeUrl.protocol === 'https:' ? '443' : '80');
  if (parsedPort !== runtimePort) {
    return parsed;
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }

  const rewritten = new URL(parsed.toString());
  rewritten.protocol = runtimeUrl.protocol;
  rewritten.host = runtimeUrl.host;
  return rewritten;
};

export const resolveInstanceApiBaseUrlAfterLogin = (
  params: { enteredUrl: string },
): { apiBaseUrl: string; origin: string } => {
  const input = typeof params.enteredUrl === 'string' ? params.enteredUrl.trim() : '';
  if (!input) {
    throw new Error('Instance URL is required');
  }

  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input);

  let parsed: URL;
  if (hasExplicitScheme) {
    parsed = new URL(input);
  } else {
    const hostPart = input.split('/')[0] || '';
    const hostCandidate = hostPart.startsWith('[')
      ? hostPart.split(']')[0]?.slice(1) || ''
      : hostPart.split(':')[0] || '';
    const inferredProtocol = isLikelyLocalHostname(hostCandidate) ? 'http' : 'https';
    parsed = new URL(`${inferredProtocol}://${input}`);
  }

  parsed = normalizeLocalOriginForCurrentRuntime(parsed);

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Instance URL must use http or https');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const apiBaseUrl = normalizedPath.endsWith('/api')
    ? `${parsed.origin}${normalizedPath}`
    : `${parsed.origin}/api`;

  return {
    apiBaseUrl,
    origin: new URL(apiBaseUrl).origin,
  };
};
