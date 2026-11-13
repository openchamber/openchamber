import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};

/**
 * A remote MCP server over Streamable HTTP and, optionally, its OAuth
 * authorization server, on one loopback listener. It records what it saw so
 * tests can check which credential reached it, by hash only.
 */
export async function startHttpFixture({ bearer = null, oauth = false } = {}) {
  const seen = { authorizations: [], deletes: 0, posts: 0, registrations: 0, revocations: [], refreshes: 0 };
  const state = {
    accessTokens: new Set(bearer ? [bearer] : []),
    refreshTokens: new Map(),
    codes: new Map(),
    rejectRefresh: false,
    expiresIn: 3600,
    redirectTo: null,
    // `{ grant, arrived, release }`: holds the next token answer of that grant
    // type after the request was accepted, so a test can act in between.
    tokenGate: null,
    // The MCP endpoint refuses every access token, freshly issued ones too.
    refuseAccessTokens: false,
  };
  const holdIfGated = async (grant) => {
    const gate = state.tokenGate;
    if (gate?.grant !== grant) return;
    state.tokenGate = null;
    gate.arrived();
    await gate.release;
  };
  const hash = (value) => createHash('sha256').update(value ?? '').digest('hex');
  const sessions = new Set();
  let origin = '';
  const issueTokens = () => {
    const accessToken = `at-${randomBytes(12).toString('hex')}`;
    const refreshToken = `rt-${randomBytes(12).toString('hex')}`;
    state.accessTokens.add(accessToken);
    state.refreshTokens.set(refreshToken, true);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: state.expiresIn, scope: 'read' };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const authorization = req.headers.authorization ?? '';
    if (url.pathname === '/mcp') {
      if (state.redirectTo) {
        res.writeHead(307, { location: state.redirectTo });
        return res.end();
      }
      seen.authorizations.push(hash(authorization.replace(/^Bearer /, '')));
      if (state.refuseAccessTokens || !state.accessTokens.has(authorization.replace(/^Bearer /, ''))) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end('{"error":"invalid_token"}');
      }
      if (req.method === 'DELETE') {
        seen.deletes += 1;
        sessions.delete(req.headers['mcp-session-id']);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
        return setTimeout(() => res.end(), 50);
      }
      seen.posts += 1;
      const message = JSON.parse(await readBody(req));
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === 'initialize') {
        const sessionId = randomBytes(8).toString('hex');
        sessions.add(sessionId);
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1.0.0' } } }, { 'mcp-session-id': sessionId });
      }
      if (!sessions.has(req.headers['mcp-session-id'])) return json(res, 404, { error: 'unknown session' });
      if (message.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'remote_echo', inputSchema: { type: 'object' } }] } });
      if (message.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo ${message.params?.arguments?.text ?? ''}` }] } })}\n\n`);
        return res.end();
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    if (!oauth) return json(res, 404, {});
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/as') {
      return json(res, 200, {
        issuer: `${origin}/as`,
        authorization_endpoint: `${origin}/as/authorize`,
        token_endpoint: `${origin}/as/token`,
        registration_endpoint: `${origin}/as/register`,
        revocation_endpoint: `${origin}/as/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/as/register') {
      seen.registrations += 1;
      const body = JSON.parse(await readBody(req));
      return json(res, 201, { client_id: `client-${seen.registrations}`, redirect_uris: body.redirect_uris });
    }
    if (url.pathname === '/as/authorize') {
      // Approves at once, as a person clicking "allow" would.
      const code = randomBytes(8).toString('hex');
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirectUri: url.searchParams.get('redirect_uri'), resource: url.searchParams.get('resource') });
      const target = new URL(url.searchParams.get('redirect_uri'));
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: target.href });
      return res.end();
    }
    if (url.pathname === '/as/token') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const entry = state.codes.get(form.get('code'));
        state.codes.delete(form.get('code'));
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
        await holdIfGated('authorization_code');
        return json(res, 200, issueTokens());
      }
      if (form.get('grant_type') === 'refresh_token') {
        seen.refreshes += 1;
        if (state.rejectRefresh || !state.refreshTokens.has(form.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
        state.refreshTokens.delete(form.get('refresh_token'));
        await holdIfGated('refresh_token');
        return json(res, 200, issueTokens());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/as/revoke') {
      const form = new URLSearchParams(await readBody(req));
      seen.revocations.push(form.get('token_type_hint'));
      state.accessTokens.delete(form.get('token'));
      state.refreshTokens.delete(form.get('token'));
      res.writeHead(200);
      return res.end();
    }
    return json(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    seen,
    state,
    hash,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
