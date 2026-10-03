import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';
import { injectGuestDocumentStyles } from './html-styles.js';
import { registerGuestRoutes } from './routes.js';
import { setCapabilityGrants, writeExtensionStore } from './persist.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('approved origins in the frame policy', () => {
  test('open only once the user approved exactly the declared list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-origins-')); roots.push(root);
    const packageRoot = path.join(root, 'guest'); await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'guest', version: '1.0.0', openchamber: { apiVersion: 1, contributes: { panel: { id: 'fonts-guest', name: 'Fonts', icon: 'apps', entry: 'index.html' }, origins: ['https://fonts.example.com'] } } }));
    const persistPath = path.join(root, 'extensions.json');
    await writeExtensionStore(persistPath, { paths: [packageRoot], sources: { [packageRoot]: 'path' } });
    const app = express(); registerGuestRoutes(app, { openchamberDataDir: root });
    const policy = async () => (await request(app).get('/api/guests/fonts-guest/index.html').set('Host', 'oc.test').expect(200)).headers['content-security-policy'];

    expect(await policy()).not.toContain('https://fonts.example.com');
    await setCapabilityGrants('fonts-guest', persistPath, ['origins'], { origins: ['https://fonts.example.com'] });
    const approved = await policy();
    expect(approved).toContain('font-src \'self\' data: blob: https://fonts.example.com');
    expect(approved).toContain('connect-src oc.test/api/guests/fonts-guest/ https://fonts.example.com');
    expect(approved).not.toMatch(/script-src[^;]*fonts\.example\.com/);
  });
});

describe('guest document styles', () => {
  test('preserves doctypes, CSP, and tag-like text inside authored scripts', () => {
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="style-src \'self\'"><script>const text = "</head><head>";</script></head><body>Guest</body></html>';
    const decorated = injectGuestDocumentStyles(html);
    const meta = '<meta name="color-scheme" content="light dark">';
    expect(decorated.startsWith(`<!doctype html>${meta}${html.slice('<!doctype html>'.length)}`)).toBe(true);
    expect(decorated).toContain(GUEST_SCROLLBAR_CSS);
    expect(decorated).toContain('data-openchamber-guest-styles');
    expect(decorated).toContain(`<script data-openchamber-guest-scrollbar>${GUEST_SCROLLBAR_SCRIPT}</script>`);
  });

  test('declares the color scheme before any authored content', () => {
    const meta = '<meta name="color-scheme" content="light dark">';
    expect(injectGuestDocumentStyles('<html><body>x</body></html>').startsWith(`${meta}<html>`)).toBe(true);
    expect(injectGuestDocumentStyles('\n<!DOCTYPE html>\n<html></html>').startsWith(`\n<!DOCTYPE html>${meta}\n<html>`)).toBe(true);
    // A doctype-looking string later in the document is authored text, not the doctype.
    expect(injectGuestDocumentStyles('<p>"<!doctype html>"</p>').startsWith(`${meta}<p>`)).toBe(true);
  });

  test('serves scrollbar defaults to existing guests with or without an asset token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-styles-')); roots.push(root);
    const packageRoot = path.join(root, 'guest'); await fs.mkdir(packageRoot);
    const html = '<!doctype html><html><head></head><body><script src="main.js"></script></body></html>';
    const script = 'console.log("existing bundle");';
    await fs.writeFile(path.join(packageRoot, 'index.html'), html);
    await fs.writeFile(path.join(packageRoot, 'main.js'), script);
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'guest', version: '1.0.0', openchamber: { apiVersion: 1, contributes: { panel: { id: 'old-guest', name: 'Old guest', icon: 'apps', entry: 'index.html' } } } }));
    await writeExtensionStore(path.join(root, 'extensions.json'), { paths: [packageRoot], sources: { [packageRoot]: 'path' } });
    const app = express(); registerGuestRoutes(app, { openchamberDataDir: root });
    for (const suffix of ['', '?oc_url_token=fixture-scope']) {
      const response = await request(app).get(`/api/guests/old-guest/index.html${suffix}`).set('Host', 'oc.example:3000').expect(200);
      // Sandboxed and off the network: its own package path is the one place it may connect.
      const csp = response.headers['content-security-policy'];
      expect(csp).toMatch(/^sandbox allow-scripts; default-src 'none';/);
      expect(csp).toContain('connect-src oc.example:3000/api/guests/old-guest/;');
      // Fonts and fetch from the null-origin frame are CORS requests.
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain(GUEST_SCROLLBAR_CSS);
      expect(response.text).toContain(GUEST_SCROLLBAR_SCRIPT);
      expect(response.text.startsWith('<!doctype html>')).toBe(true);
      expect(response.text).toContain(suffix ? 'main.js?oc_url_token=fixture-scope' : 'src="main.js"');
    }
    expect((await request(app).get('/api/guests/old-guest/main.js').expect(200)).text).toBe(script);
    // A Host that is not a plain host[:port] never reaches the policy: no connections at all.
    // The app UI draws a package icon as a CSS mask, a CORS fetch from its own
    // origin; the answer the server's CORS layer gave it must survive.
    const uiApp = express();
    uiApp.use((req, res, next) => {
      if (req.headers.origin === 'openchamber-ui://app') res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      next();
    });
    registerGuestRoutes(uiApp, { openchamberDataDir: root });
    const fromUi = await request(uiApp).get('/api/guests/old-guest/main.js').set('Origin', 'openchamber-ui://app').expect(200);
    expect(fromUi.headers['access-control-allow-origin']).toBe('openchamber-ui://app');
    const fromFrame = await request(uiApp).get('/api/guests/old-guest/main.js').set('Origin', 'null').expect(200);
    expect(fromFrame.headers['access-control-allow-origin']).toBe('null');
    const forged = await request(app).get('/api/guests/old-guest/index.html').set('Host', "evil.test; connect-src *").expect(200);
    expect(forged.headers['content-security-policy']).toContain("connect-src 'none';");
    expect(await fs.readFile(path.join(packageRoot, 'index.html'), 'utf8')).toBe(html);
  });
});
