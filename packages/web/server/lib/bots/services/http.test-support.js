import http from 'node:http';

export const accountCredential = (id = 'account-one', userId = 42) => ({
  credentialId: id, credentialRevision: 1, providerUserId: `github.com#${userId}`,
  accessToken: `secret-${id}`, status: 'valid', user: { id: userId, login: `user-${userId}` },
});
export const gitHubTarget = { repositoryId: 'repo-one', owner: 'acme', repo: 'example' };
export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const pullResponse = (overrides = {}) => ({ number: 17, node_id: 'PR_seventeen', state: 'open',
  head: { sha: HEAD, ref: 'bot/item-one', repo: { full_name: 'acme/example' } },
  base: { ref: 'main', repo: { full_name: 'acme/example' } }, ...overrides,
});
export const issueResponse = (statusId = '1') => ({ id: '123', key: 'TEST-7', fields: {
  project: { key: 'TEST' }, summary: 'A controlled issue', status: { id: statusId, name: 'Current' }, description: null,
} });

/** HTTPS production URLs are forwarded to an explicit local HTTP fixture only here. */
export async function controlledUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry = { path: request.url, method: request.method, headers: request.headers,
      body: raw ? JSON.parse(raw) : null };
    requests.push(entry);
    try {
      const result = await handler(entry);
      if (result?.disconnect) { request.socket.destroy(); return; }
      response.writeHead(result?.status ?? 200, { 'content-type': 'application/json', ...result?.headers });
      response.end(result?.raw ?? JSON.stringify(result?.body ?? {}));
    } catch {
      response.writeHead(500).end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origins = [];
  return {
    requests, origins,
    fetchImpl: (url, options) => {
      const parsed = new URL(url);
      origins.push(parsed.origin);
      return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, options);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export const disconnectedPolicy = { env: {}, readFile: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } };
export const enterprisePolicy = (destinations = []) => ({ env: {}, readFile: () => JSON.stringify({
  enterpriseMode: true, allowedBotDestinations: destinations,
}) });
