import http from 'node:http';


const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const readVariable = (env: NodeJS.ProcessEnv, name: string) => String(env[name] ?? env[name.toLowerCase()] ?? '').trim();

interface ProxyEnv {
  NO_PROXY: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
}

export const resolveOutboundProxyEnv = (env: NodeJS.ProcessEnv) => {
  const httpProxy = readVariable(env, 'HTTP_PROXY');
  const httpsProxy = readVariable(env, 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return null;
  const bypass = readVariable(env, 'NO_PROXY').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const host of LOOPBACK_HOSTS) {
    if (!bypass.includes(host)) bypass.push(host);
  }
  const proxyEnv: ProxyEnv = { NO_PROXY: bypass.join(',') };
  if (httpProxy) proxyEnv.HTTP_PROXY = httpProxy;
  if (httpsProxy) proxyEnv.HTTPS_PROXY = httpsProxy;
  return proxyEnv;
};

const hasErrorMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

export const applyOutboundProxyFromEnv = ({ env = process.env, httpModule = http }: {
  env?: NodeJS.ProcessEnv;
  httpModule?: typeof http & { setGlobalProxyFromEnv?: (env: ProxyEnv) => void };
} = {}) => {
  const proxyEnv = resolveOutboundProxyEnv(env);
  if (!proxyEnv) return false;
  env.NO_PROXY = proxyEnv.NO_PROXY;
  env.no_proxy = proxyEnv.NO_PROXY;
  try {
    httpModule.setGlobalProxyFromEnv?.(proxyEnv);
  } catch (error) {
    console.warn('Could not apply the proxy from HTTP_PROXY/HTTPS_PROXY:', hasErrorMessage(error) ? error.message || error : error);
    return false;
  }
  return true;
};
