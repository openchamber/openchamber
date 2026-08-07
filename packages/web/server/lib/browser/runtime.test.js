import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createBrowserRuntime, resolveViewport } from './runtime.js';
import { findBrowserExecutable } from './chrome.js';

const searchPathFor = (name) => {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
};

const hasBrowser = Boolean(findBrowserExecutable({ fs, path, env: process.env, searchPathFor }));

describe('resolveViewport', () => {
  it('resolves named presets', () => {
    expect(resolveViewport({ preset: 'mobile' })).toMatchObject({ preset: 'mobile', width: 390, mobile: true });
  });
  it('clamps custom dimensions', () => {
    expect(resolveViewport({ width: 10, height: 99999 })).toMatchObject({ preset: 'custom', width: 320, height: 2160 });
  });
});

const describeBrowser = hasBrowser ? describe : describe.skip;

describeBrowser('createBrowserRuntime (real Chrome)', () => {
  let dataDir;
  let runtime;
  let server;
  let baseUrl;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-test-'));
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><head><title>OpenChamber Test Page</title></head><body><h1 id="hi">Hello</h1><input id="field" /></body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
    runtime = createBrowserRuntime({
      fs,
      fsPromises: fs.promises,
      path,
      spawn,
      crypto,
      dataDir,
      searchPathFor,
      idleShutdownMs: 5 * 60 * 1000,
    });
  });

  afterAll(async () => {
    await runtime?.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports supported when a browser is present', () => {
    expect(runtime.state().supported).toBe(true);
  });

  it('creates a tab, navigates, and reads the title', async () => {
    const created = await runtime.executeAction('tab.create', { url: baseUrl });
    expect(typeof created.tab.id).toBe('string');
    expect(created.tab.url).toBe(baseUrl);
    const state = runtime.state();
    expect(state.running).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].title).toBe('OpenChamber Test Page');
  }, 30_000);

  it('evaluates page expressions and waits for selectors', async () => {
    const result = await runtime.executeAction('evaluate', { expression: 'document.getElementById("hi").textContent' });
    expect(result.value).toBe('Hello');
    const waited = await runtime.executeAction('wait', { selector: '#field', timeout: 5000 });
    expect(waited.matched).toBe(true);
  }, 15_000);

  it('types into a focused field via click + type + key', async () => {
    await runtime.executeAction('evaluate', { expression: 'document.getElementById("field").focus()' });
    await runtime.executeAction('type', { text: 'openchamber' });
    const typed = await runtime.executeAction('evaluate', { expression: 'document.getElementById("field").value' });
    expect(typed.value).toBe('openchamber');
    await runtime.executeAction('key', { key: 'Control+A' });
    await runtime.executeAction('key', { key: 'Backspace' });
    const cleared = await runtime.executeAction('evaluate', { expression: 'document.getElementById("field").value' });
    expect(cleared.value).toBe('');
  }, 15_000);

  it('captures a screenshot artifact', async () => {
    const { artifact } = await runtime.executeAction('screenshot', {});
    expect(artifact.kind).toBe('screenshot');
    expect(artifact.bytes).toBeGreaterThan(0);
    const read = await runtime.readArtifact(artifact.id);
    expect(read.contentType).toBe('image/png');
    expect(read.buffer.length).toBe(artifact.bytes);
  }, 15_000);

  it('records browser activity into an artifact', async () => {
    await runtime.executeAction('recording.start', {});
    expect(runtime.state().recording?.active).toBe(true);
    await runtime.executeAction('navigate', { url: baseUrl });
    const { artifact } = await runtime.executeAction('recording.stop', {});
    expect(artifact.kind).toBe('recording');
    expect(runtime.state().recording).toBeNull();
    const read = await runtime.readArtifact(artifact.id);
    const manifest = JSON.parse(read.buffer.toString('utf8'));
    expect(manifest.kind).toBe('recording');
    expect(Array.isArray(manifest.frames)).toBe(true);
  }, 20_000);

  it('rejects non-web navigation targets', async () => {
    await expect(runtime.executeAction('navigate', { url: 'file:///etc/passwd' })).rejects.toThrow();
  });

  it('applies viewport presets', async () => {
    const { tab } = await runtime.executeAction('viewport', { preset: 'mobile' });
    expect(tab.viewport).toMatchObject({ preset: 'mobile', width: 390, mobile: true });
  }, 10_000);

  it('closes tabs', async () => {
    const state = runtime.state();
    const tabId = state.tabs[0].id;
    await runtime.executeAction('tab.close', { tabId });
    expect(runtime.state().tabs).toHaveLength(0);
  }, 10_000);
});
