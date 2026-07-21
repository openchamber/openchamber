import { describe, expect, it } from 'vitest';

import {
  applyPreviewPassthroughRequestHeaders,
  applyPreviewPassthroughResponseHeaders,
  classifyPreviewNavigation,
  classifyPreviewResourceError,
  createPreviewProxyRuntime,
  normalizeProxyTargetUrl,
  PREVIEW_TARGET_ERROR_HEADER,
  rewritePreviewBody,
  rewritePreviewCspHeader,
  rewritePreviewRedirectLocation,
} from './proxy-runtime.js';

const createResponse = () => {
  const headers = new Map();
  return {
    body: null,
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
};

const createAttachedPreviewRuntime = () => {
  let proxyOptions;
  const postRoutes = new Map();
  const useRoutes = new Map();
  let randomByte = 0;
  const runtime = createPreviewProxyRuntime({
    crypto: {
      randomBytes(size) {
        randomByte += 1;
        return Buffer.alloc(size, randomByte);
      },
    },
    URL,
    createProxyMiddleware(options) {
      proxyOptions = options;
      const middleware = () => {};
      middleware.upgrade = () => {};
      return middleware;
    },
    responseInterceptor: (handler) => handler,
  });
  const app = {
    post(path, ...handlers) {
      postRoutes.set(path, handlers);
    },
    use(path, ...handlers) {
      useRoutes.set(path, handlers);
    },
  };
  runtime.attach(app, {
    server: { on() {} },
    express: { json: () => (_req, _res, next) => next() },
    uiAuthController: null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
  });

  return { postRoutes, proxyOptions: () => proxyOptions, useRoutes };
};

const rewrite = (bodyText, kind) => rewritePreviewBody({
  bodyText,
  kind,
  proxyBasePath: '/api/preview/proxy/abc123',
  targetOrigin: 'http://127.0.0.1:3000',
});

describe('preview target failure signaling', () => {
  it('marks missing and expired targets instead of relying on the HTTP status alone', () => {
    const { useRoutes } = createAttachedPreviewRuntime();
    const [guard] = useRoutes.get('/api/preview/proxy');
    for (const [originalUrl, code, error] of [
      ['/api/preview/proxy/', 'missing', 'Preview target not found'],
      [`/api/preview/proxy/${'a'.repeat(32)}/`, 'expired', 'Preview target expired'],
    ]) {
      const response = createResponse();
      guard({ originalUrl, headers: {} }, response, () => {});
      expect(response.statusCode).toBe(404);
      expect(response.headers.get(PREVIEW_TARGET_ERROR_HEADER)).toBe(code);
      expect(response.body).toEqual({ error });
    }
  });

  it('marks invalid target tokens and accepts a registered target token', async () => {
    const { postRoutes, useRoutes } = createAttachedPreviewRuntime();
    const [, registerTarget] = postRoutes.get('/api/preview/targets');
    const [guard] = useRoutes.get('/api/preview/proxy');
    const registrationResponse = createResponse();
    await registerTarget({ body: { url: 'http://127.0.0.1:4323/' }, secure: false }, registrationResponse);

    const { id, previewToken } = registrationResponse.body;
    const invalidResponse = createResponse();
    guard({ originalUrl: `/api/preview/proxy/${id}/`, headers: {} }, invalidResponse, () => {});
    expect(invalidResponse.statusCode).toBe(403);
    expect(invalidResponse.headers.get(PREVIEW_TARGET_ERROR_HEADER)).toBe('invalid-token');

    const validResponse = createResponse();
    let continued = false;
    guard({
      originalUrl: `/api/preview/proxy/${id}/?oc_preview_token=${previewToken}`,
      headers: {},
    }, validResponse, () => {
      continued = true;
    });
    expect(continued).toBe(true);
    expect(validResponse.headers.has(PREVIEW_TARGET_ERROR_HEADER)).toBe(false);
  });

  it('removes the reserved target-error marker from upstream responses', async () => {
    const { postRoutes, proxyOptions, useRoutes } = createAttachedPreviewRuntime();
    const [, registerTarget] = postRoutes.get('/api/preview/targets');
    const registrationResponse = createResponse();
    await registerTarget({ body: { url: 'http://127.0.0.1:4323/' }, secure: false }, registrationResponse);
    const { id, previewToken } = registrationResponse.body;
    const request = {
      originalUrl: `/api/preview/proxy/${id}/missing?oc_preview_token=${previewToken}`,
      headers: {},
    };
    const response = createResponse();
    response.setHeader(PREVIEW_TARGET_ERROR_HEADER, 'expired');

    await proxyOptions().on.proxyRes(
      Buffer.from('{"error":"upstream missing"}'),
      { headers: { 'content-type': 'application/json' } },
      request,
      response,
    );

    expect(response.headers.has(PREVIEW_TARGET_ERROR_HEADER)).toBe(false);
    const [guard] = useRoutes.get('/api/preview/proxy');
    let continued = false;
    guard(request, createResponse(), () => {
      continued = true;
    });
    expect(continued).toBe(true);
  });
});

describe('preview Inertia header passthrough', () => {
  it('forwards Inertia request headers to the preview target', () => {
    const forwarded = new Map();
    const proxyReq = {
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughRequestHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-version': 'asset-hash',
        'x-unrelated': 'ignored',
      },
    }, proxyReq);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-version')).toBe('asset-hash');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });

  it('forwards Inertia response headers back to the preview client', () => {
    const forwarded = new Map();
    const res = {
      headersSent: false,
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughResponseHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-location': 'http://127.0.0.1:8000/login',
        'x-unrelated': 'ignored',
      },
    }, res);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-location')).toBe('http://127.0.0.1:8000/login');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });
});

describe('preview resource error classification', () => {
  it('suppresses Astro/Vite stylesheet modules reported as failed scripts', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/styles/global.css',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/pages/support.astro?astro&type=style&index=0&lang.css',
    })).toBe('suppress');
  });

  it('suppresses framework virtual modules reported by dev servers', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/layouts/BaseLayout.astro?astro&type=script&index=0&lang.ts',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@vite/client',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@id/astro:scripts/page.js',
    })).toBe('suppress');
  });

  it('suppresses conservative ecosystem dev-runtime resources', () => {
    const noisyResources = [
      '/_next/static/chunks/webpack.js',
      '/_next/static/chunks/react-refresh.js',
      '/.svelte-kit/generated/client/app.js',
      '/@id/__x00__virtual:sveltekit:browser',
      '/@remix-run/dev/dist/browser.js',
      '/__hmr?runtime=remix',
      '/_nuxt/@vite/client',
      '/_nuxt/@id/virtual:nuxt:%2FUsers%2Fapp',
      '/webpack-dev-server/client/index.js',
      '/webpack/hot/dev-server.js',
      '/__webpack_hmr',
    ];

    for (const resource of noisyResources) {
      expect(classifyPreviewResourceError({
        tagName: 'script',
        url: `http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc${resource}`,
      })).toBe('suppress');
    }
  });

  it('keeps ordinary application resource failures visible', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/assets/app.js',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'img',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/missing.png',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/styles/missing.css',
    })).toBe('report');
  });
});

describe('preview body URL rewriting', () => {
  it('rewrites only HTML resource attributes in HTML responses', () => {
    const input = '<img src="/logo.png"><a href="/docs">Docs</a><script>const url = "/api/data";</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('src="/api/preview/proxy/abc123/logo.png"');
    expect(output).toContain('href="/api/preview/proxy/abc123/docs"');
    expect(output).toContain('const url = "/api/data";');
  });

  it('rewrites inline module imports in HTML responses', () => {
    const input = [
      '<script type="module">',
      'import RefreshRuntime from "/@react-refresh";',
      'window.__vite_plugin_react_preamble_installed__ = true;',
      '</script>',
      '<script type=module>',
      'import { injectIntoGlobalHook } from "/@react-refresh";',
      'import value from "/module.js";',
      'const url = "/api/data";',
      '</script>',
      '<script type=\'module\'>',
      'import "/entry.js";',
      '</script>',
      '<script type="text/javascript">',
      'import "/not-rewritten.js";',
      '</script>',
      '<script>const refreshUrl = "/@react-refresh";</script>',
    ].join('');
    const output = rewrite(input, 'html');

    expect(output).toContain('from "/api/preview/proxy/abc123/@react-refresh"');
    expect(output).toContain('import { injectIntoGlobalHook } from "/api/preview/proxy/abc123/@react-refresh";');
    expect(output).toContain('import value from "/api/preview/proxy/abc123/module.js";');
    expect(output).toContain('const url = "/api/data";');
    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js";');
    expect(output).toContain('import "/not-rewritten.js";');
    expect(output).toContain('window.__vite_plugin_react_preamble_installed__ = true;');
    expect(output).toContain('const refreshUrl = "/@react-refresh";');
  });

  it('removes CSP meta tags that block the preview bridge', () => {
    const input = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><div>Preview</div>';
    const output = rewrite(input, 'html');

    expect(output).not.toContain('Content-Security-Policy');
    expect(output).toContain('<div>Preview</div>');
  });

  it('adds preview and URL auth tokens to rewritten proxy resources when provided', () => {
    const output = rewritePreviewBody({
      bodyText: '<script src="/entry.js"></script><script type="module">import RefreshRuntime from "/@react-refresh";</script><a href="http://localhost:3000/docs?x=1&oc_client_token=legacy">Docs</a>',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });

    expect(output).toContain('src="/api/preview/proxy/abc123/entry.js?oc_preview_token=preview-secret&oc_url_token=url-secret"');
    expect(output).toContain('from "/api/preview/proxy/abc123/@react-refresh?oc_preview_token=preview-secret&oc_url_token=url-secret"');
    expect(output).toContain('href="/api/preview/proxy/abc123/docs?x=1&oc_preview_token=preview-secret&oc_url_token=url-secret"');
    expect(output).not.toContain('oc_client_token');
  });

  it('rewrites only CSS imports and url references in CSS responses', () => {
    const input = '@import "/theme.css"; .hero { background: url(/hero.png); } .copy::after { content: "/not-a-url"; }';
    const output = rewrite(input, 'css');

    expect(output).toContain('@import "/api/preview/proxy/abc123/theme.css"');
    expect(output).toContain('url(/api/preview/proxy/abc123/hero.png)');
    expect(output).toContain('content: "/not-a-url"');
  });

  it('rewrites only JavaScript static import specifiers in JavaScript responses', () => {
    const input = 'import "/entry.js"; import value from "/module.js"; const url = "/api/data"; fetch("/api/data");';
    const output = rewrite(input, 'javascript');

    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js"');
    expect(output).toContain('from "/api/preview/proxy/abc123/module.js"');
    expect(output).toContain('const url = "/api/data"');
    expect(output).toContain('fetch("/api/data")');
  });

  it('adds URL auth tokens to CSS and JavaScript rewritten resources', () => {
    const cssOutput = rewritePreviewBody({
      bodyText: '@import "/theme.css"; .hero { background: url(/hero.png); }',
      kind: 'css',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });
    const jsOutput = rewritePreviewBody({
      bodyText: 'import("/entry.js"); import value from "/module.js";',
      kind: 'javascript',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    });

    expect(cssOutput).toContain('@import "/api/preview/proxy/abc123/theme.css?oc_preview_token=preview-secret&oc_url_token=url-secret"');
    expect(cssOutput).toContain('url(/api/preview/proxy/abc123/hero.png?oc_preview_token=preview-secret&oc_url_token=url-secret)');
    expect(jsOutput).toContain('import("/api/preview/proxy/abc123/entry.js?oc_preview_token=preview-secret&oc_url_token=url-secret")');
    expect(jsOutput).toContain('from "/api/preview/proxy/abc123/module.js?oc_preview_token=preview-secret&oc_url_token=url-secret"');
  });

  it('rewrites relative module import paths in JavaScript responses (issue #2338)', () => {
    const jsOutput = rewritePreviewBody({
      bodyText: 'import { defineComponent } from "./DlAUqK2U.js";\nconst mod = await import("./chunk-abc123.js");\nimport("../parent.js").then(m => m.default);',
      kind: 'javascript',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      modulePath: '/_nuxt/entry.js',
    });

    expect(jsOutput).toContain('from "/api/preview/proxy/abc123/_nuxt/DlAUqK2U.js?oc_preview_token=preview-secret"');
    expect(jsOutput).toContain('import("/api/preview/proxy/abc123/_nuxt/chunk-abc123.js?oc_preview_token=preview-secret")');
    expect(jsOutput).toContain('import("/api/preview/proxy/abc123/parent.js?oc_preview_token=preview-secret")');
  });

  it('leaves relative imports unchanged when modulePath is not provided', () => {
    const jsOutput = rewritePreviewBody({
      bodyText: 'import { defineComponent } from "./DlAUqK2U.js";',
      kind: 'javascript',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    });

    expect(jsOutput).toContain('from "./DlAUqK2U.js"');
  });

  it('strips crossorigin="" from modulepreload <link> tags (issue #2338)', () => {
    const output = rewritePreviewBody({
      bodyText: '<link rel="modulepreload" crossorigin="" href="/_nuxt/C2VRKy4g.js">',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
    });

    expect(output).not.toMatch(/crossorigin/i);
    expect(output).toContain('href="/api/preview/proxy/abc123/_nuxt/C2VRKy4g.js?oc_preview_token=preview-secret"');
  });

  it('strips crossorigin="" from module <script> tags (issue #2338)', () => {
    const output = rewritePreviewBody({
      bodyText: '<script crossorigin="" src="/_nuxt/entry.js" type="module"></script>',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
    });

    expect(output).not.toMatch(/crossorigin/i);
    expect(output).toContain('src="/api/preview/proxy/abc123/_nuxt/entry.js?oc_preview_token=preview-secret"');
  });

  it('strips crossorigin="anonymous" from tags (issue #2338)', () => {
    const output = rewritePreviewBody({
      bodyText: '<link rel="modulepreload" crossorigin="anonymous" href="/_nuxt/C2VRKy4g.js"><script crossorigin=\'anonymous\' src="/_nuxt/app.js" type="module"></script>',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
    });

    expect(output).not.toMatch(/crossorigin/i);
  });

  it('does not strip crossorigin from inline script JavaScript identifiers (issue #2338)', () => {
    const output = rewritePreviewBody({
      bodyText: '<script type="module">if (window.crossoriginEnabled) { console.log("test"); }</script><link rel="modulepreload" crossorigin="" href="/_nuxt/C2VRKy4g.js">',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
    });

    expect(output).toContain('crossoriginEnabled');
    expect(output).not.toMatch(/<link[^>]*crossorigin/i);
  });
});

describe('preview redirect URL rewriting', () => {
  it('rewrites loopback redirects through the preview proxy', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/login?next=%2F#top',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    })).toBe('/api/preview/proxy/abc123/login?next=%2F#top');
  });

  it('leaves external redirects unchanged', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com/login',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    })).toBe('https://example.com/login');
  });

  it('adds proxy auth tokens to loopback redirects when provided', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/login?next=%2F#top',
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
      previewToken: 'preview-secret',
      urlAuthToken: 'url-secret',
    })).toBe('/api/preview/proxy/abc123/login?next=%2F&oc_preview_token=preview-secret&oc_url_token=url-secret#top');
  });

  it('leaves redirects unchanged when no target origin is provided', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:5174/callback',
      proxyBasePath: '/api/preview/proxy/abc123',
      previewToken: 'preview-secret',
    })).toBe('http://localhost:5174/callback');
  });
});

describe('preview navigation policy', () => {
  const currentUrl = 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/docs';

  it('keeps same-page hash and already-proxied links in the iframe', () => {
    expect(classifyPreviewNavigation({ url: '#section', currentUrl }).action).toBe('allow');
    expect(classifyPreviewNavigation({
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/roadmap',
      currentUrl,
    }).action).toBe('allow');
  });

  it('routes loopback absolute links through the preview proxy', () => {
    expect(classifyPreviewNavigation({ url: 'http://localhost:3000/roadmap', currentUrl })).toEqual({
      action: 'proxy',
      url: 'http://localhost:3000/roadmap',
    });
  });

  it('maps app-origin root links back to the upstream origin while proxied', () => {
    expect(classifyPreviewNavigation({
      url: 'http://127.0.0.1:57123/support',
      currentUrl,
      targetOrigin: 'https://openchamber.dev',
    })).toEqual({
      action: 'proxy',
      url: 'https://openchamber.dev/support',
    });
  });

  it('sends non-loopback http links outside the preview iframe', () => {
    expect(classifyPreviewNavigation({ url: 'https://example.com/docs', currentUrl })).toEqual({
      action: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('leaves non-http links to browser defaults', () => {
    expect(classifyPreviewNavigation({ url: 'mailto:test@example.com', currentUrl })).toEqual({
      action: 'allow',
      url: 'mailto:test@example.com',
    });
  });
});

describe('proxy target normalization (SSRF guard)', () => {
  it('allows ordinary external hosts when allowExternal is set', () => {
    expect(normalizeProxyTargetUrl('https://docs.openchamber.dev/security/', { allowExternal: true }))
      .toEqual({ ok: true, origin: 'https://docs.openchamber.dev' });
  });

  it('rejects non-loopback hosts without allowExternal', () => {
    expect(normalizeProxyTargetUrl('https://example.com/', {}).ok).toBe(false);
  });

  it('refuses private, loopback and link-local literals on the external path', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.9.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://localhost/',
      'http://service.local/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://2130706433/', // decimal form of 127.0.0.1, normalized by WHATWG URL
    ]) {
      expect(normalizeProxyTargetUrl(url, { allowExternal: true }).ok, url).toBe(false);
    }
  });

  it('still blocks private hosts even via IPv4-mapped IPv6', () => {
    expect(normalizeProxyTargetUrl('http://[::ffff:127.0.0.1]/', { allowExternal: true }).ok).toBe(false);
  });
});

describe('preview CSP rewrite', () => {
  it('drops frame-ancestors and require-trusted-types-for but keeps the rest', () => {
    const result = rewritePreviewCspHeader(
      "default-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'",
      'abc123',
    );
    expect(result).not.toContain('frame-ancestors');
    expect(result).not.toContain('require-trusted-types-for');
    expect(result).toContain("default-src 'self'");
  });

  it('adds the nonce to an existing script-src instead of removing it', () => {
    const result = rewritePreviewCspHeader("script-src 'self'", 'abc123');
    expect(result).toContain("script-src 'self' 'nonce-abc123'");
  });

  it('adds the nonce to script-src-elem when present', () => {
    const result = rewritePreviewCspHeader("script-src-elem 'self'", 'abc123');
    expect(result).toContain("script-src-elem 'self' 'nonce-abc123'");
  });

  it('synthesizes script-src from default-src when no script directive exists', () => {
    const result = rewritePreviewCspHeader("default-src 'self' https://cdn.example.com", 'abc123');
    expect(result).toContain("default-src 'self' https://cdn.example.com");
    expect(result).toContain("script-src 'self' https://cdn.example.com 'nonce-abc123'");
  });

  it("drops a lone 'none' so the nonce takes effect", () => {
    const result = rewritePreviewCspHeader("script-src 'none'", 'abc123');
    expect(result).toBe("script-src 'nonce-abc123'");
  });

  it('returns empty/unset CSP values unchanged', () => {
    expect(rewritePreviewCspHeader('', 'abc123')).toBe('');
    expect(rewritePreviewCspHeader(undefined, 'abc123')).toBe(undefined);
  });
});
