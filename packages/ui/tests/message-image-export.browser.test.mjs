// Opt in with OPENCHAMBER_TEST_CHROME=/path/to/chrome node --test packages/ui/tests/message-image-export.browser.test.mjs
// Starts an isolated Vite fixture, never the OpenChamber application server.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from '../../../scripts/perf/cdp.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('message image export contains wide tables and formulas without reflowing prose in LTR and RTL', {
    skip: !process.env.OPENCHAMBER_TEST_CHROME && 'Set OPENCHAMBER_TEST_CHROME to run the browser regression',
    timeout: 120_000,
}, async (t) => {
    const { createServer } = await import('vite');
    // Resolve fixture dependencies from their owning workspace, including Bun's isolated installs.
    mkdirSync(path.join(repo, 'packages/ui/tmp'), { recursive: true });
    const fixture = mkdtempSync(path.join(repo, 'packages/ui/tmp/message-image-export-'));
    let server;
    let browser;
    let client;
    try {
        writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script type="module" src="/fixture.ts"></script></body></html>');
        writeFileSync(path.join(fixture, 'fixture.ts'), `
            import { buildTurnImageExportSource, fitMessageImageExportLayout } from '@/components/chat/message/imageExport';
            import { toPng } from 'html-to-image';
            import '@/index.css';
            import '@/styles/katex-css';

            window.runExport = async (direction, kind) => {
                const prose = 'A paragraph with enough words to wrap across several lines in the original message column. '.repeat(5);
                const table = '| ' + Array.from({ length: 10 }, (_, i) => 'Column ' + i).join(' | ') + ' |\\n'
                    + '| ' + Array(10).fill('---').join(' | ') + ' |\\n'
                    + '| ' + Array(10).fill('UnwrappableColumnValue').join(' | ') + ' |';
                const formula = '$$\\n' + Array(50).fill('x_{123}').join(' + ') + '\\n$$';
                const clone = await buildTurnImageExportSource([prose + '\\n\\n' + (kind === 'table' ? table : formula) + '\\n\\n' + prose], null);
                // The renderer mounts I18nProvider, which applies the default locale to html.
                // Set the layout direction after rendering so both cases exercise the fitter.
                document.documentElement.dir = direction;
                document.documentElement.style.direction = direction;
                const wrapper = document.createElement('div');
                wrapper.dataset.messageImageExport = 'true';
                wrapper.style.cssText = 'display:inline-block;padding:24px;width:360px;box-sizing:content-box';
                const style = document.createElement('style');
                style.textContent = '[data-message-image-export] * { scrollbar-width:none } [data-message-image-export] *::-webkit-scrollbar { display:none }';
                wrapper.append(style, clone);
                document.body.append(wrapper);
                clone.style.width = '360px';
                await document.fonts.ready;
                const paragraphs = [...clone.querySelectorAll('p')];
                const before = paragraphs.map(p => ({ width: p.getBoundingClientRect().width, height: p.getBoundingClientRect().height }));
                fitMessageImageExportLayout(wrapper, clone, 360);
                const bounds = wrapper.getBoundingClientRect();
                const painted = kind === 'table' ? [...clone.querySelectorAll('th, td')] : [...clone.querySelectorAll('.katex-html, .katex-html *')];
                if (!painted.length) throw new Error('Missing real rendered ' + kind);
                const blocks = painted.map(el => {
                    const r = el.getBoundingClientRect();
                    let clipped = false;
                    for (let parent = el.parentElement; parent && parent !== wrapper; parent = parent.parentElement) {
                        const style = getComputedStyle(parent);
                        const box = parent.getBoundingClientRect();
                        if (style.overflowX !== 'visible' && (r.left < box.left - 1 || r.right > box.right + 1)) clipped = true;
                        if (style.overflowY !== 'visible' && (r.top < box.top - 1 || r.bottom > box.bottom + 1)) clipped = true;
                    }
                    return { left: r.left - bounds.left, right: r.right - bounds.left, top: r.top - bounds.top, bottom: r.bottom - bounds.top, clipped };
                });
                const after = paragraphs.map(p => ({ width: p.getBoundingClientRect().width, height: p.getBoundingClientRect().height }));
                const width = Math.ceil(bounds.width);
                const height = Math.ceil(bounds.height);
                const data = await toPng(wrapper, { width, height, pixelRatio: 1 });
                const image = new Image();
                image.src = data;
                await image.decode();
                const result = { before, after, blocks, width, height, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, direction: getComputedStyle(clone).direction };
                wrapper.remove();
                return result;
            };
        `);
        server = await createServer({
            configFile: false, root: fixture, logLevel: 'error', cacheDir: path.join(fixture, '.vite'),
            css: { postcss: repo },
            resolve: { alias: { '@': path.join(repo, 'packages/ui/src'), '@openchamber/sdk': path.join(repo, 'packages/sdk/src/index.ts') } },
            server: { host: 'localhost', port: 0, hmr: false, watch: null, fs: { allow: [repo, realpathSync(path.join(repo, 'node_modules'))] } },
        });
        await server.listen();
        const port = await reservePort();
        browser = launchChrome({ chrome: resolveChrome(process.env.OPENCHAMBER_TEST_CHROME), port, profileDir: path.join(fixture, 'profile'), headless: true });
        const target = await createPageTarget(port);
        client = new CdpClient(target.webSocketDebuggerUrl);
        await client.connect();
        const browserErrors = [];
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
            browserErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
        });
        client.on('Log.entryAdded', ({ entry }) => {
            if (entry.level === 'error') browserErrors.push(entry.text);
        });
        client.on('Runtime.consoleAPICalled', ({ type, args }) => {
            if (type === 'error') browserErrors.push(args.map(arg => arg.value ?? arg.description).join(' '));
        });
        await client.send('Runtime.enable');
        await client.send('Log.enable');
        const evaluate = async expression => {
            const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
            return result.result.value;
        };
        await client.send('Page.enable');
        await client.send('Page.navigate', { url: server.resolvedUrls.local[0] });
        const deadline = Date.now() + 60_000;
        while (!await evaluate('typeof window.runExport === "function"')) {
            assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
            assert.ok(Date.now() < deadline, 'Fixture loaded');
            await wait(50);
        }
        for (const direction of ['ltr', 'rtl']) {
            for (const kind of ['table', 'formula']) {
                await t.test(direction + ' ' + kind, async () => {
                    const result = await evaluate('window.runExport(' + JSON.stringify(direction) + ',' + JSON.stringify(kind) + ')');
                    const label = direction + ' ' + kind;
                    assert.ok(result.before.length >= 2, label + ': prose rendered');
                    assert.ok(result.before.every(p => p.width === 360 && p.height > 30), label + ': prose wraps at the original column width');
                    assert.deepEqual(result.after, result.before, label + ': prose keeps its wrapping');
                    assert.equal(result.direction, direction, label + ': text direction preserved');
                    assert.ok(result.width > 408, label + ': canvas expands for the wide block');
                    assert.equal(result.imageWidth, result.width, label + ': PNG width');
                    assert.equal(result.imageHeight, result.height, label + ': PNG height');
                    for (const block of result.blocks) {
                        assert.equal(block.clipped, false, label + ': no ancestor clips the block');
                        assert.ok(block.left >= 23 && block.right <= result.width - 23, label + ': horizontal containment ' + JSON.stringify(block));
                        assert.ok(block.top >= 23 && block.bottom <= result.height - 23, label + ': vertical containment ' + JSON.stringify(block));
                    }
                });
            }
        }
    } finally {
        client?.close();
        if (browser && browser.exitCode === null) {
            const exited = once(browser, 'exit');
            browser.kill('SIGTERM');
            await Promise.race([exited, wait(3_000)]);
            if (browser.exitCode === null) browser.kill('SIGKILL');
        }
        server?.httpServer?.closeAllConnections();
        await server?.close();
        rmSync(fixture, { recursive: true, force: true });
    }
});
