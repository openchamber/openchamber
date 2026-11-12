import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('./webviewHtml.ts', import.meta.url), 'utf8');
const chatViewProviderSource = readFileSync(new URL('./ChatViewProvider.ts', import.meta.url), 'utf8');

describe('VS Code webview content security policy', () => {
  test('allows blob URLs for workers without allowing blob scripts', () => {
    const workerSource = source.match(/const workerSrc = ([^\n]+);/)?.[1] ?? '';
    const scriptSource = source.match(/const scriptSrc = ([^\n]+);/)?.[1] ?? '';

    assert.match(workerSource, /'blob:'/);
    assert.doesNotMatch(scriptSource, /'blob:'/);
    assert.match(source, /worker-src \$\{workerSrc\}/);
  });

  test('installs a CSP document before changing sidebar webview options', () => {
    assert.match(source, /getCspBootstrapHtml[\s\S]*Content-Security-Policy[\s\S]*default-src 'none'/);

    const bootstrap = chatViewProviderSource.indexOf('webviewView.webview.html = getCspBootstrapHtml()');
    const options = chatViewProviderSource.indexOf('webviewView.webview.options =');
    const application = chatViewProviderSource.indexOf('webviewView.webview.html = this._getHtmlForWebview');
    assert.ok(bootstrap >= 0 && bootstrap < options && options < application);
  });
});
