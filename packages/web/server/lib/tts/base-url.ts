import { isEnterpriseMode } from '../enterprise-mode.js';

const isString = (value: unknown): value is string => typeof value === 'string';

const LOCAL_BASE_URL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

const isEnvFlagEnabled = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const normalizeHostname = (hostname: string) => {
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const isAllowedLocalHost = (hostname: string) => {
  const normalized = normalizeHostname(hostname);
  return LOCAL_BASE_URL_HOSTS.has(normalized);
};

export const normalizeCustomOpenAIBaseURL = (value: Parameters<typeof isString>[0]) => {
  if (!isString(value) || !value.trim()) {
    return { value: undefined };
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { error: 'Custom server URL is invalid', code: 'invalid_base_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Custom server URL must use http or https', code: 'invalid_base_url' };
  }

  if (parsed.username || parsed.password) {
    return { error: 'Custom server URL must not include credentials', code: 'invalid_base_url' };
  }

  if (isEnterpriseMode() && !isAllowedLocalHost(parsed.hostname)) {
    return { error: 'In enterprise mode a custom speech server has to run on this machine.', code: 'enterprise_mode' };
  }

  const isDesktop = (process.env.OPENCHAMBER_RUNTIME || '').trim().toLowerCase() === 'desktop';
  const envFlagRaw = process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
  const hasExplicitFlag = envFlagRaw !== undefined && envFlagRaw.trim().length > 0;
  const allowRemote = hasExplicitFlag ? isEnvFlagEnabled(envFlagRaw) : isDesktop;
  if (!allowRemote && !isAllowedLocalHost(parsed.hostname)) {
    return {
      error: 'Remote custom server URLs are disabled. Set OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS=true to allow this host.',
      code: 'remote_disabled',
    };
  }

  parsed.hash = '';
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalizedPath = pathname.length > 0 ? pathname : '';
  return { value: `${parsed.protocol}//${parsed.host}${normalizedPath}` };
};
