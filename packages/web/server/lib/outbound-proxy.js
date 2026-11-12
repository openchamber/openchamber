import http from 'node:http';

// Outbound requests from the server follow the standard proxy variables
// (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, either case), so usage quotas, catalogs
// and other upstream calls work behind a corporate or local proxy without
// NODE_USE_ENV_PROXY. Loopback always stays direct: OAuth callbacks, the
// managed OpenCode server and SSH forwards live there, and a proxy that
// cannot reach this machine's 127.0.0.1 would break them.

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const readVariable = (env, name) => String(env[name] ?? env[name.toLowerCase()] ?? '').trim();

/**
 * The proxy settings the environment asks for, with loopback added to the
 * bypass list, or null when no proxy is configured.
 */
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

/**
 * Route this process's fetch and http(s) requests through the configured
 * proxy. NO_PROXY is written back to the environment so clients that read it
 * themselves (Bun's fetch, child processes) keep loopback direct too.
 * Returns whether a proxy was configured.
 */
export const applyOutboundProxyFromEnv = ({ env = process.env, httpModule = http } = {}) => {
  const proxyEnv = resolveOutboundProxyEnv(env);
  if (!proxyEnv) return false;
  env.NO_PROXY = proxyEnv.NO_PROXY;
  env.no_proxy = proxyEnv.NO_PROXY;
  // Node 24 and Electron's Node apply this to fetch and http(s); Bun's fetch
  // reads the variables directly.
  try {
    httpModule.setGlobalProxyFromEnv?.(proxyEnv);
  } catch (error) {
    console.warn('Could not apply the proxy from HTTP_PROXY/HTTPS_PROXY:', error?.message || error);
    return false;
  }
  return true;
};
