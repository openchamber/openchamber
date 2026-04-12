const LOCAL_BASE_URL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const normalizeHostname = (hostname) => {
  if (typeof hostname !== 'string') return '';
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const isAllowedLocalHost = (hostname) => {
  const normalized = normalizeHostname(hostname);
  return LOCAL_BASE_URL_HOSTS.has(normalized);
};

export const normalizeCustomOpenAIBaseURL = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return { value: undefined };
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { error: 'Custom server URL is invalid' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Custom server URL must use http or https' };
  }

  if (parsed.username || parsed.password) {
    return { error: 'Custom server URL must not include credentials' };
  }

  const allowRemote = isEnvFlagEnabled(process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS);
  if (!allowRemote && !isAllowedLocalHost(parsed.hostname)) {
    return {
      error: 'Remote custom server URLs are disabled. Set OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS=true to allow this host.',
    };
  }

  parsed.hash = '';
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalizedPath = pathname.length > 0 ? pathname : '';
  return { value: `${parsed.protocol}//${parsed.host}${normalizedPath}` };
};
