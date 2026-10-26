/**
 * Checks whether a remote MCP server can join the catalog as a one-click
 * OAuth entry, the way OpenCode 2.x signs in to it. See DOCUMENTATION.md
 * (Vetting a candidate) for how to read the result.
 *
 *   node packages/ui/src/lib/integrations-catalog/probe-mcp.mjs <mcp-url>... [--register]
 *
 * Without --register the probe only reads: the server's 401 challenge and its
 * OAuth metadata. With --register it also registers a throwaway client named
 * "opencode" with a loopback redirect, exactly as OpenCode does, and asks for
 * the authorization page without following it. That leaves an unused client
 * on the vendor's side and nothing else.
 */

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
});

const readJson = async (url) => {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

/** Authorization server metadata, looked up the ways RFC 8414 and OIDC allow. */
const readServerMetadata = async (issuer) => {
  const base = new URL(issuer);
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${path}`,
    `${base.origin}${path}/.well-known/oauth-authorization-server`,
    `${base.origin}/.well-known/openid-configuration${path}`,
    `${base.origin}${path}/.well-known/openid-configuration`,
  ];
  for (const candidate of candidates) {
    const metadata = await readJson(candidate);
    if (metadata?.authorization_endpoint) return metadata;
  }
  return null;
};

const probe = async (mcpUrl, register) => {
  const report = { server: mcpUrl };
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: INIT_BODY,
    redirect: 'manual',
  });
  report.initialize = response.status;
  if (response.status === 200) {
    report.verdict = 'open: answers without sign-in (no-auth entry, or a token that is optional)';
    return report;
  }
  if (response.status === 403) {
    report.verdict = 'closed: refuses before any sign-in';
    return report;
  }

  const challenge = response.headers.get('www-authenticate') ?? '';
  const origin = new URL(mcpUrl).origin;
  const resourcePath = new URL(mcpUrl).pathname.replace(/\/$/, '');
  const resourceMetadataUrls = [
    challenge.match(/resource_metadata="([^"]+)"/)?.[1],
    `${origin}/.well-known/oauth-protected-resource${resourcePath}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  let issuer = origin;
  for (const url of resourceMetadataUrls) {
    const resource = await readJson(url);
    if (resource?.authorization_servers?.length) {
      issuer = resource.authorization_servers[0];
      break;
    }
  }

  const metadata = await readServerMetadata(issuer);
  if (!metadata) {
    report.verdict = 'no OAuth metadata: likely a token header (check vendor docs)';
    return report;
  }
  report.issuer = issuer;
  report.dynamicRegistration = Boolean(metadata.registration_endpoint);
  report.clientMetadataDocument = metadata.client_id_metadata_document_supported === true;
  report.tokenAuthMethods = metadata.token_endpoint_auth_methods_supported ?? null;
  if (!report.dynamicRegistration) {
    report.verdict = 'needs a registered app: no dynamic client registration';
    return report;
  }
  if (!register) {
    report.verdict = 'candidate: advertises dynamic registration; rerun with --register to confirm';
    return report;
  }

  const port = 20000 + Math.floor(Math.random() * 20000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const registration = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: 'opencode',
      client_uri: 'https://opencode.ai',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const registered = await registration.json().catch(() => null);
  if (!registered?.client_id) {
    report.registration = `${registration.status} ${JSON.stringify(registered)?.slice(0, 200)}`;
    report.verdict = 'needs a registered app: registration refused';
    return report;
  }

  const authorize = new URL(metadata.authorization_endpoint);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', registered.client_id);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  authorize.searchParams.set('code_challenge_method', 'S256');
  // OpenCode sends a random state and the RFC 8707 resource, as the MCP SDK
  // does; some servers reject a short state or a missing resource.
  authorize.searchParams.set('state', crypto.randomUUID());
  authorize.searchParams.set('resource', mcpUrl);
  const page = await fetch(authorize, { redirect: 'manual' });
  const location = page.headers.get('location') ?? '';
  const body = page.status >= 400 ? (await page.text()).slice(0, 300) : '';
  report.authorize = `${page.status} ${location.slice(0, 160)}`;
  report.verdict = page.status >= 400 || /error=/.test(location)
    ? `needs a registered app: authorization refused (${body.replace(/\s+/g, ' ').slice(0, 160)})`
    : 'one-click OAuth: confirm with a real sign-in before shipping';
  return report;
};

const register = process.argv.includes('--register');
const urls = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (urls.length === 0) {
  console.error('usage: node probe-mcp.mjs <mcp-url>... [--register]');
  process.exit(1);
}
for (const url of urls) {
  try {
    console.log(JSON.stringify(await probe(url, register), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ server: url, verdict: `unreachable: ${error.message}` }));
  }
}
