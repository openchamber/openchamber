
interface LoopbackHttpDescriptor {
  presentation?: {
    instances?: { allowLoopbackHttp?: boolean };
  };
}

interface LoopbackHttpProviders {
  list?: () => readonly LoopbackHttpDescriptor[];
}

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isLoopbackHost = (host: string | null | undefined) => {
  const value = String(host ?? '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || LOOPBACK_V4.test(value);
};

export const descriptorAllowsLoopbackHttp = (descriptor: LoopbackHttpDescriptor | null | undefined) => descriptor?.presentation?.instances?.allowLoopbackHttp === true;

export const loopbackHttpPermitted = (host: string, providers: LoopbackHttpProviders | null | undefined) => isLoopbackHost(host)
  && Boolean(providers?.list?.().some(descriptorAllowsLoopbackHttp));
