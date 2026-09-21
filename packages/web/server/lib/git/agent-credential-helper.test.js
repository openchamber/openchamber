import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HELPER = fileURLToPath(new URL('./agent-credential-helper.js', import.meta.url));

const listen = (host, answer) => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
  });
  server.listen(0, host, () => resolve({ server, requests, port: server.address().port }));
});

const runHelper = (env, stdin = 'protocol=https\nhost=github.com\n') => new Promise((resolve) => {
  const child = execFile(process.execPath, [HELPER, 'get'], { env: { ...process.env, ...env } }, (_error, stdout) => resolve(stdout));
  child.stdin.end(stdin);
});

describe('agent credential helper', () => {
  let server;
  afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  it.each([['127.0.0.1', '127.0.0.1'], ['::1', '[::1]']])(
    'reaches the callback the server chose on %s and answers the managed credential',
    async (bindHost, urlHost) => {
      const listening = await listen(bindHost, { mode: 'managed', username: 'x-access-token', password: 'secret-value' });
      server = listening.server;
      const stdout = await runHelper({
        OPENCHAMBER_GIT_CREDENTIAL_URL: `http://${urlHost}:${listening.port}/api/git/agent-credential`,
        OPENCHAMBER_GIT_CREDENTIAL_TOKEN: 'child-token',
      });
      expect(stdout).toBe('username=x-access-token\npassword=secret-value\n\n');
      expect(listening.requests).toEqual([expect.objectContaining({
        authorization: 'Bearer child-token',
        body: expect.objectContaining({ query: 'protocol=https\nhost=github.com\n' }),
      })]);
    },
  );

  it('stays silent when the callback is not plain HTTP or is missing', async () => {
    expect(await runHelper({ OPENCHAMBER_GIT_CREDENTIAL_URL: 'https://127.0.0.1:1/x', OPENCHAMBER_GIT_CREDENTIAL_TOKEN: 't' })).toBe('');
    expect(await runHelper({ OPENCHAMBER_GIT_CREDENTIAL_URL: '', OPENCHAMBER_GIT_CREDENTIAL_TOKEN: '' })).toBe('');
  });
});
