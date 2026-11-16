const normalizeAddress = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
};

const isLoopbackAddress = (value) => {
  const address = normalizeAddress(value);
  return address === '127.0.0.1' || address === '::1';
};

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

const resolveConcreteBoundAddress = (value) => {
  const address = normalizeAddress(value);
  return address && !WILDCARD_ADDRESSES.has(address) ? address : null;
};

export const createCallbackAddress = (getActiveHost = () => null) => {
  const getConcreteBoundAddress = () => resolveConcreteBoundAddress(getActiveHost());

  const callbackHost = () => {
    const address = getConcreteBoundAddress() || '127.0.0.1';
    return address.includes(':') ? `[${address}]` : address;
  };

  const isSameMachineAddress = (value) => {
    if (isLoopbackAddress(value)) return true;
    const boundAddress = getConcreteBoundAddress();
    return boundAddress !== null && normalizeAddress(value) === boundAddress;
  };

  return Object.freeze({ callbackHost, isSameMachineAddress });
};
