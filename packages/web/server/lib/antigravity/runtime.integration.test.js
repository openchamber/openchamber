import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityRuntime } from './runtime.js';

const directories = [];
const processGroups = [];

const createFixture = async ({ onSpawn = () => {}, getActivePort = () => 1234 } = {}) => {
  const directory = await fsPromises.mkdtemp(path.join(tmpdir(), 'oc-agy-test-'));
  directories.push(directory);
  await fsPromises.writeFile(path.join(directory, 'agy'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.4.12');
} else if (args.includes('models')) {
  console.log('test-model\\tTest model');
} else if (args.includes('oversized-diagnostics')) {
  process.stderr.write('Bearer ' + 'synthetic'.repeat(3000));
  console.log(JSON.stringify({ status: 'ERROR', error: 'Test error' }));
} else if (args.includes('wait-for-stop')) {
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', () => console.log(JSON.stringify({ ready: true, descendant: child.pid })));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ status: 'SUCCESS', response: 'done', conversation_id: 'conv-test' }));
}
`, { mode: 0o700 });
  vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`);
  const runtime = createAntigravityRuntime({
    crypto,
    fs,
    fsPromises,
    path,
    spawn: (...args) => {
      const child = spawn(...args);
      if (child.pid) processGroups.push(child.pid);
      onSpawn(child, args[1]);
      return child;
    },
    instanceDir: directory,
    readSettings: () => ({ antigravityDelegationEnabled: true }),
    resolveSessionDirectory: () => directory,
    getActivePort,
  });
  return runtime;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of processGroups.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  for (const directory of directories.splice(0)) {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('Antigravity process boundary', () => {
  it('resumes a failed first turn even if the optional skill cannot register', async () => {
    const calls = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      calls.push(JSON.parse(body));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(calls.length === 1
        ? { ok: false, error: { code: 'TIMEOUT', message: 'Test timeout', details: { conversationId: 'conv-first' } } }
        : { ok: true, data: { response: 'done', conversationId: 'conv-first', durationMs: 1 } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = await createFixture({ getActivePort: () => server.address().port });
      for (const [key, value] of Object.entries(await runtime.createChildEnv())) vi.stubEnv(key, value);
      for (const key of ['NO_PROXY', 'no_proxy']) vi.stubEnv(key, process.env[key] ?? '');
      const plugin = await import(pathToFileURL(path.join(await runtime.materializePlugin(), 'index.js')).href);
      let tool;
      await plugin.default.setup({
        tool: { transform: async (transform) => transform({ add: (definition) => { tool = definition; } }) },
        skill: { transform: async () => { throw new Error('Test skill registration failure'); } },
      });
      const context = { sessionID: 'ses_test', signal: new AbortController().signal };
      expect((await tool.execute({ prompt: 'first turn' }, context)).content).toContain('conv-first');
      expect((await tool.execute({ prompt: 'continue' }, context)).content).toContain('done');
      expect(calls[1].conversation).toBe('conv-first');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not launch model discovery if policy changes after the version process', async () => {
    const calls = [];
    const runtime = await createFixture({
      onSpawn: (child, args) => {
        calls.push(args);
        if (args.includes('--version')) {
          child.once('close', () => vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1'));
        }
      },
    });
    const status = await runtime.status({ force: true });
    expect(status.blocked).toBe(true);
    expect(calls).toEqual([['--version']]);
  });

  it('omits oversized diagnostics without retaining an opaque credential fragment', async () => {
    const runtime = await createFixture();
    try {
      await runtime.run({ prompt: 'oversized-diagnostics', sessionID: 'ses_test' });
      throw new Error('Expected a CLI failure');
    } catch (error) {
      expect(error.code).toBe('AGY_FAILED');
      expect(error.details.stderr).not.toContain('synthetic');
      expect(error.details.stderr).toContain('omitted');
    }
  });

  it('refuses new processes after shutdown starts', async () => {
    const calls = [];
    const runtime = await createFixture({ onSpawn: (_child, args) => calls.push(args) });
    await runtime.stop();
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_test' }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('waits for SIGKILL escalation before shutdown finishes', async () => {
    const ready = Promise.withResolvers();
    const runtime = await createFixture({
      onSpawn: (child) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('\n')) ready.resolve(JSON.parse(output.trim()));
        });
      },
    });
    const turn = runtime.run({ prompt: 'wait-for-stop', sessionID: 'ses_test' })
      .then(() => 'completed', (error) => error.code);
    const { descendant } = await ready.promise;
    await runtime.stop();
    expect(await turn).toBe('CANCELLED');
    const status = await fsPromises.readFile(`/proc/${descendant}/status`, 'utf8').catch(() => 'State:\tZ');
    expect(status).toMatch(/State:\s+Z/);
  });
});
