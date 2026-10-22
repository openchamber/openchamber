/**
 * Plain HTTP for Git transport, allowed in one case only: a provider instance
 * on this machine. A descriptor whose `presentation.instances.allowLoopbackHttp`
 * is set (Gitea, Gerrit: a local development site on http://localhost) may be
 * reached over HTTP when the host is a loopback address; every other host is
 * HTTPS or SSH, so nothing leaves this machine in the clear.
 */

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** `localhost`, `127.0.0.0/8` or `::1` (bracketed or not), compared lowercase. */
export const isLoopbackHost = (host) => {
  const value = String(host ?? '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || LOOPBACK_V4.test(value);
};

/** Whether a provider's descriptor lets its instances be loopback HTTP origins. */
export const descriptorAllowsLoopbackHttp = (descriptor) => descriptor?.presentation?.instances?.allowLoopbackHttp === true;

/**
 * Whether a registered provider would serve an HTTP endpoint on `host`: the
 * host is loopback and some provider allows loopback HTTP instances. Used
 * where an endpoint has no provider attached yet (planning, a stored plan);
 * a managed credential checks its own provider and instance as well.
 */
export const loopbackHttpPermitted = (host, providers) => isLoopbackHost(host)
  && Boolean(providers?.list?.().some(descriptorAllowsLoopbackHttp));
