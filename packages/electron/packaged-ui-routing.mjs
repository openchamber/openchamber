const RUNTIME_PATH = /^\/(?:api(?:\/|$)|auth(?:\/|$)|health$)/;

export const isPackagedUiRuntimeRequest = (requestUrl) =>
  RUNTIME_PATH.test(new URL(requestUrl).pathname);

export const resolvePackagedUiRuntimeRequest = (requestUrl, apiBaseUrl) => {
  const request = new URL(requestUrl);
  if (!RUNTIME_PATH.test(request.pathname)) return null;

  let base;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  return new URL(`${request.pathname}${request.search}`, `${base.origin}/`).toString();
};
