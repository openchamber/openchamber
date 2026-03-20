/**
 * Anthropic OAuth Handler
 * 
 * Implements OAuth 2.0 with PKCE for Anthropic/Anthropic Claude.
 */

import { readAuthFile, writeAuthFile } from './auth.js';

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL_CONSOLE = 'https://console.anthropic.com/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function startAnthropicOAuth() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();

  const url = new URL(AUTH_URL_CONSOLE);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', 'https://console.anthropic.com/oauth/code/callback');
  url.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return {
    url: url.toString(),
    verifier: codeVerifier,
    state: state
  };
}

export async function completeAnthropicOAuth(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: code,
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  const json = await response.json();
  
  const auth = readAuthFile();
  auth['anthropic'] = {
    type: 'oauth',
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  writeAuthFile(auth);

  return {
    success: true,
    providerId: 'anthropic'
  };
}

export function isAnthropicProvider(providerId) {
  return ['anthropic', 'claude'].includes(providerId.toLowerCase());
}
