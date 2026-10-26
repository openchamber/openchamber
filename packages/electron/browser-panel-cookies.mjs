/**
 * Session cookies (no expiry) of the browser panel survive a restart.
 *
 * Electron drops them when the app quits, and many sign-ins keep the login in
 * exactly such a cookie, so the user was signed out on every launch. Before
 * quitting they are written back with an expiry, the way Chrome keeps them
 * when it continues where you left off. A site that signs the user out still
 * deletes the cookie itself.
 */

/** Chromium's ceiling for a cookie's lifetime. */
const KEEP_SECONDS = 400 * 24 * 60 * 60;

export const persistentCookieDetails = (cookie, nowSeconds) => ({
  url: `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`,
  name: cookie.name,
  value: cookie.value,
  // A host-only cookie stays host-only: naming a domain would widen it to subdomains.
  domain: cookie.hostOnly ? undefined : cookie.domain,
  path: cookie.path || '/',
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  expirationDate: nowSeconds + KEEP_SECONDS,
});

/** Gives every session cookie in `cookies` an expiry; one that cannot be rewritten is left as it was. */
export const keepSessionCookies = async (cookies, { nowSeconds = Date.now() / 1000, onError } = {}) => {
  const all = await cookies.get({});
  await Promise.all(all
    .filter((cookie) => cookie.session && cookie.domain)
    .map((cookie) => cookies.set(persistentCookieDetails(cookie, nowSeconds)).catch((error) => onError?.(error))));
};
