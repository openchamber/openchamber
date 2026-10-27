/**
 * deepseek-backend.adversarial.test.js — route-level probes.
 *
 * These tests deliberately call the runtime the way the REAL OpenChamber route
 * layer does (see ../opencode/openchamber-routes.js), NOT the way the author's
 * own suite calls it. If the adapter only supports its self-invented calling
 * convention, these fail.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeepSeekBackendRuntime } from './deepseek-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DSH = join(here, 'fixtures', 'fake-dsh-acp.mjs');

const makeRuntime = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-adv-'));
  const sessionsFilePath = join(directory, 'deepseek-sessions.json');
  const events = [];
  const runtime = createDeepSeekBackendRuntime({
    crypto: (await import('node:crypto')).default,
    fsPromises: (await import('node:fs')).promises,
    sessionsFilePath,
    env: { ...process.env, DEEPSEEK_DSH_BIN: process.execPath, DEEPSEEK_DSH_ARGS: FAKE_DSH },
    publishEvent: (event) => events.push(event.payload ?? event),
  });
  return { runtime, events, directory };
};

const waitFor = async (predicate, { timeout = 4000, interval = 10 } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
};

// The route layer calls: runtime.replyToPermission(requestId, reply, { directory, sessionID }).
test('ADV: replyToPermission positional (route) call convention resolves the turn', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const work = runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'needs permission' }],
    });
    const asked = await waitFor(() => events.find((e) => e.type === 'permission.asked'));

    // EXACT route call shape (positional args), not the object shape.
    const reply = await runtime.replyToPermission(asked.properties.id, 'allow-once', {
      directory,
      sessionID: session.id,
    });
    assert.equal(reply.ok, true, 'route-style replyToPermission must report ok');

    await work;
    const assistant = (await runtime.getMessages({ sessionID: session.id })).find(
      (m) => m.info.role === 'assistant',
    );
    const text = assistant.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    assert.match(text, /perm=allow-once/);
  } finally {
    await runtime._appServer.shutdown();
  }
});

// Two prompts for two DIFFERENT sessions in the SAME directory, issued before
// the first process finishes initialising, must not orphan a child process.
test('ADV: concurrent first-prompts in one directory do not double-spawn', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    // Both createSession calls race into connectProcess for the same directory.
    const [a, b] = await Promise.all([
      runtime.createSession({ directory, title: 'a' }),
      runtime.createSession({ directory, title: 'b' }),
    ]);
    await Promise.all([
      runtime.prompt({ sessionID: a.id, directory, parts: [{ type: 'text', text: 'hi a' }] }),
      runtime.prompt({ sessionID: b.id, directory, parts: [{ type: 'text', text: 'hi b' }] }),
    ]);
    const children = runtime._appServer._spawnCount();
    assert.equal(children, 1, `expected 1 ACP child for one directory, saw ${children}`);
  } finally {
    await runtime._appServer.shutdown();
  }
});
