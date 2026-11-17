
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isLoopbackHost = (host) => {
  const value = String(host ?? '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || LOOPBACK_V4.test(value);
};

export const descriptorAllowsLoopbackHttp = (descriptor) => descriptor?.presentation?.instances?.allowLoopbackHttp === true;

export const loopbackHttpPermitted = (host, providers) => isLoopbackHost(host)
  && Boolean(providers?.list?.().some(descriptorAllowsLoopbackHttp));
