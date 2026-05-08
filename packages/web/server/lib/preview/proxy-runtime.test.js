import { describe, expect, it } from 'vitest';

import { classifyPreviewNavigation, classifyPreviewResourceError, rewritePreviewBody } from './proxy-runtime.js';

const rewrite = (bodyText, kind) => rewritePreviewBody({
  bodyText,
  kind,
  proxyBasePath: '/api/preview/proxy/abc123',
  targetOrigin: 'http://127.0.0.1:3000',
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
