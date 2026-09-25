import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';
import { injectGuestDocumentStyles } from './html-styles.js';
import { registerGuestRoutes } from './routes.js';
import { writeExtensionStore } from './persist.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('guest document styles', () => {
  test('preserves doctypes, CSP, and tag-like text inside authored scripts', () => {
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="style-src \'self\'"><script>const text = "</head><head>";</script></head><body>Guest</body></html>';
    const decorated = injectGuestDocumentStyles(html);
    expect(decorated.startsWith(html)).toBe(true);
    expect(decorated).toContain(GUEST_SCROLLBAR_CSS);
    expect(decorated).toContain('data-openchamber-guest-styles');
    expect(decorated).toContain(`<script data-openchamber-guest-scrollbar>${GUEST_SCROLLBAR_SCRIPT}</script>`);
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
      const response = await request(app).get(`/api/guests/old-guest/index.html${suffix}`).expect(200);
      expect(response.headers['content-security-policy']).toBe('sandbox allow-scripts');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain(GUEST_SCROLLBAR_CSS);
      expect(response.text).toContain(GUEST_SCROLLBAR_SCRIPT);
      expect(response.text.startsWith('<!doctype html>')).toBe(true);
      expect(response.text).toContain(suffix ? 'main.js?oc_url_token=fixture-scope' : 'src="main.js"');
    }
    expect((await request(app).get('/api/guests/old-guest/main.js').expect(200)).text).toBe(script);
    expect(await fs.readFile(path.join(packageRoot, 'index.html'), 'utf8')).toBe(html);
  });
});
