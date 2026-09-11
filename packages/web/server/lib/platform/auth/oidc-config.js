// OIDC client configuration for the platform login flow (plan section 7.1).
//
// Environment variables:
//   OPENCHAMBER_PLATFORM_OIDC_ISSUER         provider issuer URL (required)
//   OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID      OAuth2 client id (required)
//   OPENCHAMBER_PLATFORM_OIDC_CLIENT_SECRET  optional; absent = public client
//   OPENCHAMBER_PLATFORM_OIDC_REDIRECT_URI   optional; when unset the callback
//                                            URL is derived per request from
//                                            the incoming origin
//
// Dev-auth gate (plan section 7.1): a non-HTTPS issuer is development-only.
// Startup must REFUSE such a configuration unless OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH
// is explicitly set to "true"; trial deployments fail closed. When dev auth is
// active the server logs a loud warning banner.

const DEV_AUTH_ENV = 'OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH';

const isExplicitTrue = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

export function isDevIssuer(issuerUrl) {
  return issuerUrl.protocol !== 'https:';
}

export function resolveOidcConfig({ env, logger = console } = {}) {
  const issuer = typeof env?.OPENCHAMBER_PLATFORM_OIDC_ISSUER === 'string'
    ? env.OPENCHAMBER_PLATFORM_OIDC_ISSUER.trim()
    : '';
  const clientId = typeof env?.OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID === 'string'
    ? env.OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID.trim()
    : '';
  const clientSecret = typeof env?.OPENCHAMBER_PLATFORM_OIDC_CLIENT_SECRET === 'string'
    && env.OPENCHAMBER_PLATFORM_OIDC_CLIENT_SECRET.length > 0
    ? env.OPENCHAMBER_PLATFORM_OIDC_CLIENT_SECRET
    : null;
  const redirectUri = typeof env?.OPENCHAMBER_PLATFORM_OIDC_REDIRECT_URI === 'string'
    && env.OPENCHAMBER_PLATFORM_OIDC_REDIRECT_URI.trim().length > 0
    ? env.OPENCHAMBER_PLATFORM_OIDC_REDIRECT_URI.trim()
    : null;

  if (!issuer) {
    throw new Error('OPENCHAMBER_PLATFORM_OIDC_ISSUER is required for platform auth');
  }
  if (!clientId) {
    throw new Error('OPENCHAMBER_PLATFORM_OIDC_CLIENT_ID is required for platform auth');
  }

  let issuerUrl;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error(`OPENCHAMBER_PLATFORM_OIDC_ISSUER is not a valid URL: ${issuer}`);
  }
  if (issuerUrl.protocol !== 'https:' && issuerUrl.protocol !== 'http:') {
    throw new Error(`OPENCHAMBER_PLATFORM_OIDC_ISSUER must use http or https: ${issuer}`);
  }

  const devAuth = isDevIssuer(issuerUrl);
  if (devAuth && !isExplicitTrue(env?.[DEV_AUTH_ENV])) {
    throw new Error(
      `refusing non-HTTPS OIDC issuer (${issuer}): set ${DEV_AUTH_ENV}=true ` +
      'to explicitly enable development auth; trial deployments must fail closed',
    );
  }
  if (devAuth) {
    logger.warn?.(
      '[platform-auth] WARNING: DEV AUTH IS ACTIVE - the OIDC issuer uses plain HTTP ' +
      `(${issuer}). This configuration is for local development only and must NOT be ` +
      'used for trial or production deployments.',
    );
  }

  return Object.freeze({ issuer, issuerUrl, clientId, clientSecret, redirectUri, devAuth });
}
