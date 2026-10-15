import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('CLIProxyAPI Antigravity account source', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cliproxy-'));
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('OC_ANTIGRAVITY_PROXY')) delete process.env[name];
    }
    process.env.OPENCODE_CONFIG_DIR = sandbox;
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    process.env.LOCALAPPDATA = sandbox;
    process.env.OC_ANTIGRAVITY_PROXY_URL = 'http://127.0.0.1:8317';
    process.env.OC_ANTIGRAVITY_PROXY_KEY = 'test-management-key';
    const provider = await import('./index.js');
    await t.test('configuration makes the existing provider available without network', () => {
      assert.equal(provider.isConfigured(), true);
    });
    const { resolveCliProxyAuth } = await import('./cliproxy.js');
    const resolve = (env = {}) => resolveCliProxyAuth(env);
    const explicit = (url = 'http://127.0.0.1:8317', key = 'test-key') => ({
      OC_ANTIGRAVITY_PROXY_URL: url, OC_ANTIGRAVITY_PROXY_KEY: key
    });
    for (const url of [
      'http://10.0.0.1:8317', 'https://example.com', 'file:///etc/passwd',
      'http://user:password@127.0.0.1:8317', 'http://127.0.0.1.example.com', 'invalid'
    ]) {
      await t.test(`rejects management target ${url}`, () => assert.equal(resolve(explicit(url)), null));
    }
    for (const url of ['http://127.0.0.1:8317', 'http://localhost:8317', 'https://[::1]:8317']) {
      await t.test(`accepts loopback target ${url}`, () => assert.ok(resolve(explicit(url))));
    }
    for (const off of ['off', '0', 'false', 'no']) {
      await t.test(`disable switch ${off} wins over configuration`, () => {
        assert.equal(resolve({ ...explicit(), OC_ANTIGRAVITY_PROXY: off }), null);
      });
    }
    for (const key of ['', 'line\nbreak', 'embedded space', 'x'.repeat(4097)]) {
      await t.test(`rejects invalid management key of length ${key.length}`, () => {
        assert.equal(resolve(explicit(undefined, key)), null);
      });
    }
    const config = path.join(sandbox, 'config.toml');
    const writeConfig = (text) => fs.writeFileSync(config, text);
    const fromConfig = () => resolve({ OC_ANTIGRAVITY_PROXY_CONFIG: config });
    await t.test('TOML handles BOM, CRLF, comments and literal strings, ending at the first table', () => {
      writeConfig('\uFEFF# config\r\nport = 1234 # port\r\n\'management-secret-key\' = \'literal-key\'\r\n[tls]\r\nport = 1\r\n');
      const source = fromConfig();
      assert.equal(source.proxyBaseUrl, 'http://127.0.0.1:1234');
      assert.equal(source.managementKey, 'literal-key');
    });
    await t.test('wildcard bind is contacted over numeric loopback', () => {
      writeConfig('host = "0.0.0.0"\nmanagement-secret-key = "test-key"');
      assert.equal(fromConfig().proxyBaseUrl, 'http://127.0.0.1:8317');
    });
    await t.test('remote bind from TOML is rejected', () => {
      writeConfig('host = "example.com"\nmanagement-secret-key = "test-key"');
      assert.equal(fromConfig(), null);
    });
    await t.test('missing management key does not configure the source', () => {
      writeConfig('port = 8317');
      assert.equal(fromConfig(), null);
    });
    await t.test('explicit invalid settings never fall back to a config file', () => {
      writeConfig('management-secret-key = "test-key"');
      assert.equal(resolve({ ...explicit('http://example.com'), OC_ANTIGRAVITY_PROXY_CONFIG: config }), null);
    });
    await t.test('key file and environment references resolve server-side', () => {
      const file = path.join(sandbox, 'key.txt');
      fs.writeFileSync(file, 'from-file\n');
      assert.equal(resolve(explicit(undefined, `{file:${file}}`)).managementKey, 'from-file');
      assert.equal(resolve({ ...explicit(undefined, '{env:TEST_KEY}'), TEST_KEY: 'from-env' }).managementKey, 'from-env');
    });
    await t.test('EasyCLIProxyAPI discovery prefers the newest numeric version', () => {
      for (const version of ['0.2.9', '0.2.75']) {
        const directory = path.join(sandbox, 'Programs', 'EasyCLIProxyAPI', `EasyCLIProxyAPI-v${version}-Windows-amd64`);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'config.toml'), `management-secret-key = "key-${version}"`);
      }
      assert.equal(resolve({ LOCALAPPDATA: sandbox }).managementKey, 'key-0.2.75');
    });
    await t.test('missing or oversized config file is not a source', () => {
      assert.equal(resolve({ OC_ANTIGRAVITY_PROXY_CONFIG: path.join(sandbox, 'missing') }), null);
      writeConfig('x'.repeat(1024 * 1024 + 1));
      assert.equal(fromConfig(), null);
    });

    const key = 'fake-management-key';
    const files = [
      { provider: 'antigravity', auth_index: 'ready', email: 'person@example.test', project_id: 'project-test', status: 'active' },
      { provider: 'antigravity', auth_index: 'disabled', disabled: true },
      { provider: 'codex', auth_index: 'codex' }
    ];
    const resetTime = '2030-01-01T00:00:00Z';
    const summary = { groups: [
      { displayName: 'Gemini Models', buckets: [
        { window: '5h', remainingFraction: 0.5, resetTime },
        { window: 'weekly', remainingFraction: 0.75, resetTime }
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        { window: '5h', remainingFraction: 0.9, resetTime },
        { window: 'weekly', remainingFraction: 0.2, resetTime }
      ] }
    ] };
    const hits = [];
    const outside = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(input).hostname)) {
        outside.push(String(input));
        return Promise.resolve(new Response('{}', { status: 400 }));
      }
      return realFetch(input, init);
    };
    let managementKey = key;
    let status = 200;
    let body = summary;
    let accountFiles = files;
    let managementStatus = 200;
    let oversizedAuthBody = false;
    let apiManagementStatus = 200;
    let failedOrigins = new Set();
    let rawBody = null;
    let hang = false;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = Buffer.concat(chunks).toString();
      hits.push({ path: req.url, authorization: req.headers.authorization, payload });
      if (hang) return;
      const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (oversizedAuthBody) {
        const code = managementStatus === 403 ? 403 : 401;
        res.writeHead(code, { 'content-length': 4 * 1024 * 1024 + 1 });
        res.end('x');
        return;
      }
      if (req.headers.authorization !== `Bearer ${managementKey}`) return send(401, { error: key });
      if (managementStatus !== 200) {
        if (managementStatus === 302) res.setHeader('location', 'http://example.invalid/secret');
        return send(managementStatus, { error: 'IP banned due to too many failed attempts. Try again in 0.01s' });
      }
      if (req.url.endsWith('/auth-files')) return send(200, { files: accountFiles });
      if (apiManagementStatus !== 200) return send(apiManagementStatus, { error: key });
      const call = JSON.parse(payload);
      if (failedOrigins.has(new URL(call.url).origin)) return send(200, { status_code: 503, body: '{}' });
      if (rawBody !== null) return send(200, { status_code: status, body: rawBody });
      return send(200, { status_code: status, body: JSON.stringify(body) });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    process.env.OC_ANTIGRAVITY_PROXY_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.OC_ANTIGRAVITY_PROXY_KEY = key;
    const fetchQuota = async () => { hits.length = 0; return provider.fetchQuota(); };
    try {
      await t.test('renders aggregate group windows with stock percentages and reset times', async () => {
        const result = await fetchQuota();
        assert.equal(result.ok, true);
        assert.equal(result.providerId, 'antigravity');
        assert.equal(result.planLabel, 'person@example.test');
        assert.deepEqual(Object.keys(result.usage.windows).sort(), ['Claude & GPT 5-Hour', 'Claude & GPT Weekly', 'Gemini 5-Hour', 'Gemini Weekly']);
        assert.equal(result.usage.windows['Gemini 5-Hour'].usedPercent, 50);
        assert.equal(result.usage.windows['Claude & GPT Weekly'].usedPercent, 80);
        assert.deepEqual(result.usage.models ?? {}, {});
      });
      await t.test('one listing and one summary call retain token placeholder and stock Google headers', async () => {
        await fetchQuota();
        assert.equal(hits.length, 2);
        assert.ok(hits.every((hit) => hit.authorization === `Bearer ${key}`));
        const call = JSON.parse(hits[1].payload);
        assert.equal(call.authIndex, 'ready');
        assert.equal(call.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
        assert.equal(call.header.Authorization, 'Bearer $TOKEN$');
        assert.equal(call.header['User-Agent'], 'antigravity/1.11.5 windows/amd64');
        assert.ok(call.header['X-Goog-Api-Client']);
        assert.ok(call.header['Client-Metadata']);
        assert.deepEqual(JSON.parse(call.data), { project: 'project-test' });
        assert.ok(!hits[1].payload.includes(key));
        assert.deepEqual(outside, []);
      });
      for (const [code, message] of [[403, /Google rejected/], [429, /rate-limited/], [500, /quota service failed/]]) {
        await t.test(`management 200 wrapping Google ${code} remains a configured failure`, async () => {
          status = code;
          const result = await fetchQuota();
          assert.equal(result.ok, false);
          assert.equal(result.configured, true);
          assert.match(result.error, message);
          status = 200;
        });
      }
      await t.test('malformed wrapped body is a failure after bounded endpoint fallback', async () => {
        rawBody = '<html>bad</html>';
        assert.equal((await fetchQuota()).ok, false);
        assert.equal(hits.length, 4);
        rawBody = null;
      });
      await t.test('empty summary never masquerades as zero usage', async () => {
        body = {};
        assert.equal((await fetchQuota()).ok, false);
        body = summary;
      });
      await t.test('Google origin fallback reaches production after daily and sandbox fail', async () => {
        failedOrigins = new Set(['https://daily-cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.sandbox.googleapis.com']);
        assert.equal((await fetchQuota()).ok, true);
        assert.deepEqual(hits.slice(1).map((hit) => JSON.parse(hit.payload).url), [
          'https://daily-cloudcode-pa.googleapis.com',
          'https://daily-cloudcode-pa.sandbox.googleapis.com',
          'https://cloudcode-pa.googleapis.com'
        ].map((origin) => `${origin}/v1internal:retrieveUserQuotaSummary`));
        failedOrigins.clear();
      });
      await t.test('proxy gateway 502 tries each stock origin at most once', async () => {
        apiManagementStatus = 502;
        assert.equal((await fetchQuota()).ok, false);
        assert.equal(hits.length, 4);
        apiManagementStatus = 200;
      });
      await t.test('api-call 400 names unresolved proxy token without leaking response body', async () => {
        apiManagementStatus = 400;
        const result = await fetchQuota();
        assert.match(result.error, /could not resolve the Antigravity token/);
        assert.ok(!JSON.stringify(result).includes(key));
        assert.equal(hits.length, 2);
        apiManagementStatus = 200;
      });
      await t.test('oversized proxy response is bounded and rejected', async () => {
        rawBody = 'x'.repeat(4 * 1024 * 1024 + 1);
        assert.match((await fetchQuota()).error, /unexpected response/);
        rawBody = null;
      });
      await t.test('ready account wins and nested account metadata is accepted', async () => {
        accountFiles = [
          { provider: 'antigravity', auth_index: 'unavailable', unavailable: true },
          { type: 'antigravity', authIndex: 'nested', attributes: { email: 'nested@example.test', projectId: 'nested-project' } }
        ];
        assert.equal((await fetchQuota()).planLabel, 'nested@example.test');
        const call = JSON.parse(hits[1].payload);
        assert.equal(call.authIndex, 'nested');
        assert.deepEqual(JSON.parse(call.data), { project: 'nested-project' });
        accountFiles = files;
      });
      await t.test('disabled source returns not configured without network', async () => {
        process.env.OC_ANTIGRAVITY_PROXY = 'off';
        assert.equal((await fetchQuota()).configured, false);
        assert.equal(hits.length, 0);
        delete process.env.OC_ANTIGRAVITY_PROXY;
      });
      await t.test('no active Antigravity account makes no forwarded call', async () => {
        accountFiles = files.slice(1);
        assert.match((await fetchQuota()).error, /no active Antigravity account/);
        assert.equal(hits.length, 1);
        accountFiles = files;
      });
      await t.test('explicit account selection is case insensitive and never silently selects another account', async () => {
        process.env.OC_ANTIGRAVITY_PROXY_ACCOUNT = 'PERSON@EXAMPLE.TEST';
        assert.equal((await fetchQuota()).ok, true);
        process.env.OC_ANTIGRAVITY_PROXY_ACCOUNT = 'missing';
        assert.equal((await fetchQuota()).ok, false);
        assert.equal(hits.length, 1);
        delete process.env.OC_ANTIGRAVITY_PROXY_ACCOUNT;
      });
      await t.test('management redirects are not followed', async () => {
        managementStatus = 302;
        assert.match((await fetchQuota()).error, /redirect/);
        assert.equal(hits.length, 1);
        assert.deepEqual(outside, []);
        managementStatus = 200;
      });
      await t.test('hanging proxy ends at the server deadline', async () => {
        hang = true;
        process.env.OC_ANTIGRAVITY_PROXY_DEADLINE_MS = '1000';
        const preceding = provider.fetchQuota();
        process.env.OC_ANTIGRAVITY_PROXY_DEADLINE_MS = '100';
        const started = Date.now();
        assert.match((await fetchQuota()).error, /timed out/);
        // Waiting behind another caller must also obey this caller's deadline.
        assert.ok(Date.now() - started < 700);
        assert.match((await preceding).error, /timed out/);
        hang = false;
        delete process.env.OC_ANTIGRAVITY_PROXY_DEADLINE_MS;
      });
      await t.test('legacy accounts retain precedence and never contact the proxy', async () => {
        const file = path.join(sandbox, 'antigravity-accounts.json');
        fs.writeFileSync(file, JSON.stringify({ accounts: [{ refreshToken: 'legacy-refresh|project' }] }));
        assert.equal((await fetchQuota()).error, 'Failed to refresh Antigravity token');
        assert.equal(hits.length, 0);
        fs.unlinkSync(file);
        outside.length = 0;
      });
      await t.test('rejected management key is sent once, including repeated refreshes', async () => {
        managementKey = 'rotated-key';
        hits.length = 0;
        const results = await Promise.all(Array.from({ length: 6 }, () => provider.fetchQuota()));
        assert.ok(results.every((result) => /rejected the management key/.test(result.error)));
        assert.equal(hits.length, 1);
        assert.match((await fetchQuota()).error, /key changes/);
        assert.equal(hits.length, 0);
      });
      await t.test('rotated key is picked up on the next fetch', async () => {
        process.env.OC_ANTIGRAVITY_PROXY_KEY = managementKey;
        assert.equal((await fetchQuota()).ok, true);
        assert.equal(hits.length, 2);
      });
      await t.test('401 headers latch rejection before an oversized body is read', async () => {
        oversizedAuthBody = true;
        process.env.OC_ANTIGRAVITY_PROXY_KEY = 'body-rejected-key';
        assert.match((await fetchQuota()).error, /rejected the management key/);
        assert.match((await fetchQuota()).error, /key changes/);
        assert.equal(hits.length, 0);
        oversizedAuthBody = false;
        process.env.OC_ANTIGRAVITY_PROXY_KEY = managementKey;
      });
      await t.test('management ban suppresses requests even after a key change, then expires', async () => {
        managementStatus = 403;
        assert.match((await fetchQuota()).error, /blocks management access/);
        assert.equal(hits.length, 1);
        process.env.OC_ANTIGRAVITY_PROXY_KEY = 'another-key';
        assert.match((await fetchQuota()).error, /next attempt/);
        assert.equal(hits.length, 0);
        await new Promise((done) => setTimeout(done, 1100));
        managementStatus = 200;
        process.env.OC_ANTIGRAVITY_PROXY_KEY = managementKey;
        assert.equal((await fetchQuota()).ok, true);
      });
      await t.test('results never expose management keys, project IDs or token values', async () => {
        const serialized = JSON.stringify(await fetchQuota());
        for (const secret of [key, managementKey, 'project-test', '$TOKEN$']) assert.ok(!serialized.includes(secret));
      });
      await t.test('403 headers latch a conservative ban even when its body is oversized', async () => {
        oversizedAuthBody = true;
        managementStatus = 403;
        assert.match((await fetchQuota()).error, /blocks management access/);
        assert.match((await fetchQuota()).error, /next attempt in 30 min/);
        assert.equal(hits.length, 0);
        oversizedAuthBody = false;
        managementStatus = 200;
      });
      await t.test('unreachable proxy is a configured failure', async () => {
        const unused = http.createServer();
        await new Promise((done) => unused.listen(0, '127.0.0.1', done));
        const port = unused.address().port;
        await new Promise((done) => unused.close(done));
        process.env.OC_ANTIGRAVITY_PROXY_URL = `http://127.0.0.1:${port}`;
        const result = await fetchQuota();
        assert.equal(result.configured, true);
        assert.match(result.error, /not reachable/);
      });
    } finally {
      globalThis.fetch = realFetch;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  } finally {
    process.env = saved;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
