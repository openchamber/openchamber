const RUNTIME_PATH = /^\/(?:api(?:\/|$)|auth(?:\/|$)|health$)/;

export const isPackagedUiRuntimeRequest = (requestUrl) => {
  let pathname = new URL(requestUrl).pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot name one of the reserved runtime paths.
  }
  const normalized = `/${pathname.split('/').filter(Boolean).join('/')}`;
  return RUNTIME_PATH.test(normalized);
};
