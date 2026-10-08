import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

import { applyOutboundProxyFromEnv, resolveOutboundProxyEnv } from './outbound-proxy.js';

describe('resolveOutboundProxyEnv', () => {
  it('is null without a proxy', () => {
    expect(resolveOutboundProxyEnv({ NO_PROXY: 'internal.example' })).toBeNull();
  });

  it('reads either case and always bypasses loopback', () => {
    expect(resolveOutboundProxyEnv({ https_proxy: 'http://proxy:7897', no_proxy: 'corp.example, 127.0.0.1' })).toEqual({
      HTTPS_PROXY: 'http://proxy:7897',
      NO_PROXY: 'corp.example,127.0.0.1,localhost,::1',
    });
  });
});

describe('applyOutboundProxyFromEnv', () => {
  it('leaves the process alone without a proxy', () => {
    const setGlobalProxyFromEnv = vi.fn();
    expect(applyOutboundProxyFromEnv({ env: {}, httpModule: { setGlobalProxyFromEnv } })).toBe(false);
    expect(setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it('writes the loopback bypass back for clients that read the environment', () => {
    const env = { HTTP_PROXY: 'http://proxy:3128' };
    const setGlobalProxyFromEnv = vi.fn();
    expect(applyOutboundProxyFromEnv({ env, httpModule: { setGlobalProxyFromEnv } })).toBe(true);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
    expect(setGlobalProxyFromEnv).toHaveBeenCalledWith({ HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost,127.0.0.1,::1' });
  });

  // Only Node versions with http.setGlobalProxyFromEnv route fetch through a
  // proxy this way; on older ones (CI runs Node 22) the module is a no-op.
  const nodeCanProxy = spawnSync('node', ['-p', "typeof require('node:http').setGlobalProxyFromEnv"], { encoding: 'utf8', windowsHide: true })
    .stdout?.trim() === 'function';

  it.runIf(nodeCanProxy)('sends fetch through the proxy and keeps loopback direct in a real Node process', () => {
    const moduleUrl = new URL('./outbound-proxy.js', import.meta.url).href;
    const result = spawnSync('node', ['--input-type=module', '--eval', `
      import http from 'node:http';
      import assert from 'node:assert/strict';
      const seen = [];
      const proxy = http.createServer((req, res) => res.end());
      proxy.on('connect', (req, socket) => { seen.push('proxy ' + req.url); socket.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'); });
      const local = http.createServer((req, res) => { seen.push('direct'); res.end('ok'); });
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
      const { applyOutboundProxyFromEnv } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(applyOutboundProxyFromEnv({ env: { HTTPS_PROXY: 'http://127.0.0.1:' + proxy.address().port, HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port } }), true);
      await fetch('http://upstream.invalid/usage').catch(() => {});
      assert.equal(await (await fetch('http://127.0.0.1:' + local.address().port + '/')).text(), 'ok');
      assert.deepEqual(seen, ['proxy upstream.invalid:80', 'direct']);
      process.exit(0);
    `], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
  });
});
