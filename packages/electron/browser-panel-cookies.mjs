
// external: https://developer.chrome.com/blog/cookie-max-age-expires Chromium caps cookie lifetime at 400 days.
const KEEP_SECONDS = 400 * 24 * 60 * 60;

export const persistentCookieDetails = (cookie, nowSeconds) => ({
  url: `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`,
  name: cookie.name,
  value: cookie.value,
  domain: cookie.hostOnly ? undefined : cookie.domain,
  path: cookie.path || '/',
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  expirationDate: nowSeconds + KEEP_SECONDS,
});

export const keepSessionCookies = async (cookies, { nowSeconds = Date.now() / 1000, onError } = {}) => {
  const all = await cookies.get({});
  await Promise.all(all
    .filter((cookie) => cookie.session && cookie.domain)
    .map((cookie) => cookies.set(persistentCookieDetails(cookie, nowSeconds)).catch((error) => onError?.(error))));
};
