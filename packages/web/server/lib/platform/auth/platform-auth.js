// OIDC login flow driver (plan section 7.1 steps 1-4).
//
// startLogin creates the one-time login transaction and builds the provider
// authorization redirect. completeLogin consumes the transaction, runs the
// authorization-code grant through openid-client (which validates the state,
// nonce, PKCE exchange and the id_token issuer/audience/expiry claims), then
// verifies the id_token JWS signature explicitly with jose against the
// provider's discovered JWKS - openid-client deliberately skips signature
// verification for the plain code flow. It resolves the local user strictly
// by (issuer, subject) - never by display name or email auto-linking.
//
// The openid-client Configuration is created lazily and cached; discovery is
// performed once at first use. devAuth issuers (plain http) get the explicit
// allowInsecureRequests opt-in; resolveOidcConfig already gated that behind
// OPENCHAMBER_PLATFORM_ALLOW_DEV_AUTH.

import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  None,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
// openid-client (via oauth4webapi) validates id_token issuer/audience/expiry/
// nonce claims but deliberately does NOT verify the id_token JWT signature
// for the plain authorization-code flow (it relies on TLS to the token
// endpoint). Plan section 7.1 step 2 requires full signature validation, so
// the signature is verified explicitly against the provider's discovered JWKS.
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { createLoginTransaction, consumeLoginTransaction } from './login-transactions.js';

export function createPlatformAuth({ db, oidcConfig, logger = console }) {
  let configPromise = null;

  const getConfiguration = () => {
    if (!configPromise) {
      const metadata = oidcConfig.clientSecret
        ? { client_secret: oidcConfig.clientSecret }
        : undefined;
      const clientAuth = oidcConfig.clientSecret ? undefined : None();
      configPromise = discovery(
        oidcConfig.issuerUrl,
        oidcConfig.clientId,
        metadata,
        clientAuth,
        oidcConfig.devAuth ? { execute: [allowInsecureRequests] } : {},
      ).catch((error) => {
        configPromise = null;
        throw error;
      });
    }
    return configPromise;
  };

  const redirectUriFor = (req) => {
    if (oidcConfig.redirectUri) return oidcConfig.redirectUri;
    // Derived per request so local dev and deployed origins both work without
    // a configured redirect URI. trust proxy must be enabled for req.secure.
    return `${req.protocol}://${req.get('host')}/auth/callback`;
  };

  const startLogin = async (req, { now = Date.now() } = {}) => {
    const config = await getConfiguration();
    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    await createLoginTransaction(db, { state, nonce, codeVerifier, now });
    const redirectUri = redirectUriFor(req);
    const url = buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid',
      state,
      nonce,
      code_challenge: await calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { redirectUrl: url.toString(), state };
  };

  // Error codes are stable API surface (plan section 9.1); the underlying
  // provider/library detail is logged server-side only.
  const completeLogin = async ({ state, callbackUrl, now = Date.now() }) => {
    if (typeof state !== 'string' || state.length === 0) {
      return { error: 'login_transaction_invalid' };
    }
    const transaction = await consumeLoginTransaction(db, { state, now });
    if (!transaction) {
      return { error: 'login_transaction_invalid' };
    }

    let tokens;
    try {
      const config = await getConfiguration();
      tokens = await authorizationCodeGrant(config, callbackUrl, {
        expectedState: state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        idTokenExpected: true,
      });
      // Explicit signature + issuer/audience verification against the
      // discovered JWKS (see the import comment above).
      const jwksUri = config.serverMetadata()?.jwks_uri;
      if (typeof jwksUri !== 'string' || jwksUri.length === 0) {
        throw new Error('provider discovery returned no jwks_uri');
      }
      await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(jwksUri)), {
        issuer: oidcConfig.issuer,
        audience: oidcConfig.clientId,
      });
    } catch (error) {
      logger.warn?.(`[platform-auth] OIDC callback validation failed: ${error?.message || error}`);
      return { error: 'invalid_id_token' };
    }

    const claims = typeof tokens.claims === 'function' ? tokens.claims() : null;
    const subject = claims?.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      return { error: 'invalid_id_token' };
    }

    // User resolution is strictly by (issuer, subject); no display-name or
    // email based auto-linking (plan section 7.1 step 3).
    const { rows } = await db.query(
      'SELECT * FROM users WHERE issuer = $1 AND subject = $2',
      [oidcConfig.issuer, subject],
    );
    const row = rows[0];
    if (!row) {
      return { error: 'user_not_provisioned' };
    }
    if (row.status !== 'active') {
      return { error: 'user_disabled' };
    }
    const bindingValid =
      Number.isInteger(row.linux_uid) && row.linux_uid > 0 &&
      Number.isInteger(row.linux_gid) && row.linux_gid > 0 &&
      typeof row.home_path === 'string' && /^\/.*[^/]$/.test(row.home_path);
    if (!bindingValid) {
      return { error: 'user_binding_invalid' };
    }

    return {
      user: {
        id: row.id,
        issuer: row.issuer,
        subject: row.subject,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        linuxUid: row.linux_uid,
        linuxGid: row.linux_gid,
        homePath: row.home_path,
      },
    };
  };

  return { startLogin, completeLogin };
}
