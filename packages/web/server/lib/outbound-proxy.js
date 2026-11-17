import http from 'node:http';


const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const readVariable = (env, name) => String(env[name] ?? env[name.toLowerCase()] ?? '').trim();

export const resolveOutboundProxyEnv = (env) => {
  const httpProxy = readVariable(env, 'HTTP_PROXY');
  const httpsProxy = readVariable(env, 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return null;
  const bypass = readVariable(env, 'NO_PROXY').split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const host of LOOPBACK_HOSTS) {
    if (!bypass.includes(host)) bypass.push(host);
  }
  const proxyEnv = { NO_PROXY: bypass.join(',') };
  if (httpProxy) proxyEnv.HTTP_PROXY = httpProxy;
  if (httpsProxy) proxyEnv.HTTPS_PROXY = httpsProxy;
  return proxyEnv;
};

export const applyOutboundProxyFromEnv = ({ env = process.env, httpModule = http } = {}) => {
  const proxyEnv = resolveOutboundProxyEnv(env);
  if (!proxyEnv) return false;
  env.NO_PROXY = proxyEnv.NO_PROXY;
  env.no_proxy = proxyEnv.NO_PROXY;
  // external: https://nodejs.org/api/http.html#http_proxy Built-in environment proxy support applies to Node HTTP and fetch; Bun fetch reads the variables directly.
  try {
    httpModule.setGlobalProxyFromEnv?.(proxyEnv);
  } catch (error) {
    console.warn('Could not apply the proxy from HTTP_PROXY/HTTPS_PROXY:', error?.message || error);
    return false;
  }
  return true;
};
