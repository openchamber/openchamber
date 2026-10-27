/**
 * deepseek-backend.test.js — suite mirroring the reference
 * `codex-backend.test.js` structure, but driving the real
 * jsonrpc-subprocess + deepseek-appserver + deepseek-backend stack against the
 * deterministic fake ACP server in `fixtures/fake-dsh-acp.mjs`.
 *
 * Run:  bun run test  (or: npx vitest run server/lib/harness/deepseek-backend.test.js)
 *
 * Uses `node:assert` only — everything is real I/O, no mocks.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDeepSeekBackendRuntime,
} from './deepseek-backend.js';
import { partsToAcpContentBlocks } from './deepseek-appserver.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DSH = join(here, 'fixtures', 'fake-dsh-acp.mjs');

/** Build an isolated runtime + event collector over the fake ACP server. */
const makeRuntime = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-'));
  const sessionsFilePath = join(directory, 'deepseek-sessions.json');
  const events = [];
  const runtime = createDeepSeekBackendRuntime({
    crypto: (await import('node:crypto')).default,
    fsPromises: (await import('node:fs')).promises,
    sessionsFilePath,
    env: {
      ...process.env,
      DEEPSEEK_DSH_BIN: process.execPath,
      DEEPSEEK_DSH_ARGS: FAKE_DSH,
      DEEPSEEK_PROVIDER: 'deepseek-official',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-reasoner',
    },
    publishEvent: (event) => events.push(event.payload ?? event),
  });
  return { runtime, events, directory };
};

const waitFor = async (predicate, { timeout = 5000, interval = 10 } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
};

test('capabilities are honest and under-claimed', async () => {
  const { runtime } = await makeRuntime();
  try {
    const caps = runtime.capabilities;
    assert.equal(caps.chat, true);
    assert.equal(caps.sessions, true);
    assert.equal(caps.models, true);
    assert.equal(caps.approvals, true);
    assert.equal(caps.config, true);
    // features ACP genuinely lacks must not be claimed
    assert.equal(caps.shell, false);
    assert.equal(caps.share, false);
    assert.equal(caps.agents, false);
    assert.equal(caps.providers, false);
    assert.equal(caps.auth, false);
    assert.equal(caps.commands, false);
    // binary resolution is honest against the fake interpreter
    assert.equal(runtime.isAvailable(), true);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('create -> prompt -> stream -> finalize assistant turn', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory, title: 'Stream test' });
    assert.ok(session.id);
    assert.equal(session.backendId, 'deepseek');

    const result = await runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'say hi' }],
    });
    assert.equal(result.ok, true);

    const messages = await runtime.getMessages({ sessionID: session.id });
    assert.equal(messages.length, 2);
    const [user, assistant] = messages;
    assert.equal(user.info.role, 'user');
    assert.equal(assistant.info.role, 'assistant');

    const assistantText = assistant.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    assert.match(assistantText, /Hello /);
    assert.match(assistantText, /world\./);

    const reasoning = assistant.parts.find((p) => p.type === 'reasoning');
    assert.ok(reasoning, 'expected a reasoning part from agent_thought_chunk');

    const toolPart = assistant.parts.find((p) => p.type === 'tool');
    assert.ok(toolPart, 'expected a tool part from tool_call');
    assert.equal(toolPart.state.status, 'completed');

    // streaming happened: chunks were published as part updates
    const partUpdates = events.filter((e) => e.type === 'message.part.updated');
    assert.ok(partUpdates.length >= 3, `expected streamed parts, got ${partUpdates.length}`);
    assert.ok(events.some((e) => e.type === 'session.idle'));
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('promptAsync returns immediately and still completes', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const started = await runtime.promptAsync({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'async hi' }],
    });
    assert.equal(started.ok, true);

    await waitFor(() => events.some((e) => e.type === 'session.idle'));
    const messages = await runtime.getMessages({ sessionID: session.id });
    assert.equal(messages.length, 2);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('abort cancels an in-flight turn', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const work = runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'please abort this' }],
    });
    // the fake emits one chunk then waits for session/cancel
    await waitFor(() => events.some((e) => e.type === 'message.part.updated'));
    await runtime.abortSession({ sessionID: session.id });
    await work;

    const messages = await runtime.getMessages({ sessionID: session.id });
    const assistant = messages.find((m) => m.info.role === 'assistant');
    assert.ok(assistant);
    assert.equal(assistant.info.time.stopReason, 'cancelled');
    assert.ok(events.some((e) => e.type === 'session.idle'));
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('session/request_permission round-trips an allow reply', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const work = runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'needs permission' }],
    });

    const asked = await waitFor(() => events.find((e) => e.type === 'permission.asked'));
    assert.equal(typeof asked.properties.permission, 'string');
    assert.ok(Array.isArray(asked.properties.patterns));
    assert.ok(Array.isArray(asked.properties.always));
    assert.ok(asked.properties.metadata.options.length >= 1);

    const reply = await runtime.replyToPermission({
      requestId: asked.properties.id,
      reply: 'allow-once',
    });
    assert.equal(reply.ok, true);
    assert.equal(runtime.hasPermissionRequest(asked.properties.id), false);

    await work;
    const messages = await runtime.getMessages({ sessionID: session.id });
    const assistant = messages.find((m) => m.info.role === 'assistant');
    const text = assistant.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    assert.match(text, /perm=allow-once/);
    assert.ok(events.some((e) => e.type === 'permission.replied'));
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('reject permission yields a cancelled outcome', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const work = runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'needs permission' }],
    });
    const asked = await waitFor(() => events.find((e) => e.type === 'permission.asked'));
    await runtime.replyToPermission({ requestId: asked.properties.id, reply: 'reject' });
    await work;
    const assistant = (await runtime.getMessages({ sessionID: session.id })).find(
      (m) => m.info.role === 'assistant',
    );
    const text = assistant.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    assert.match(text, /perm=cancelled/);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('process crash surfaces a session.error and restarts on the next turn', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    await assert.rejects(
      runtime.prompt({ sessionID: session.id, directory, parts: [{ type: 'text', text: 'crash' }] }),
    );
    assert.ok(events.some((e) => e.type === 'session.error'));

    // backoff, respawn, and succeed
    const ok = await runtime.prompt({
      sessionID: session.id,
      directory,
      parts: [{ type: 'text', text: 'after restart' }],
    });
    assert.equal(ok.ok, true);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('list / getMessages / delete session lifecycle', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const a = await runtime.createSession({ directory, title: 'A' });
    const b = await runtime.createSession({ directory, title: 'B' });
    const list = await runtime.listSessions({ directory });
    assert.equal(list.length, 2);

    assert.ok(await runtime.getSession({ sessionID: a.id }));
    assert.deepEqual(await runtime.getMessages({ sessionID: a.id }), []);

    await runtime.deleteSession({ sessionID: b.id });
    const after = await runtime.listSessions({ directory });
    assert.equal(after.length, 1);
    assert.equal(after[0].id, a.id);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('control surface exposes the ACP model selector', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const surface = await runtime.getControlSurface({ sessionID: session.id });
    assert.equal(surface.backendId, 'deepseek');
    assert.ok(surface.modelSelector.options.length >= 2);
    assert.ok(surface.modelSelector.options.some((o) => o.id === 'deepseek-chat'));
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('control surface advertises the pinned models before a session', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const surface = await runtime.getControlSurface({ directory });
    assert.equal(surface.modelSelector.providerId, 'deepseek-official');
    const labels = surface.modelSelector.options.map((o) => o.label);
    assert.deepEqual(labels, ['deepseek-v4-flash', 'deepseek-reasoner']);
    assert.equal(surface.modelSelector.defaultOptionId, JSON.stringify(['deepseek-official', 'deepseek-v4-flash']));
    assert.deepEqual(surface.providerSnapshot.models.map((m) => m.label), ['deepseek-v4-flash', 'deepseek-reasoner']);
    // A deepseek session can only ever use this provider.
    assert.ok(surface.providerSnapshot.models.every((m) => m.raw.providerId === 'deepseek-official'));
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('selecting a model applies the exact ACP option value', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    await runtime.prompt({
      sessionID: session.id,
      model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      parts: [{ type: 'text', text: 'hi' }],
    });
    const surface = await runtime.getControlSurface({ sessionID: session.id });
    assert.equal(surface.modelSelector.defaultOptionId, 'deepseek-chat');
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('a model from another backend falls back to an offered model', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    await runtime.prompt({
      sessionID: session.id,
      model: { providerID: 'moonshot', modelID: 'kimi-k3' },
      parts: [{ type: 'text', text: 'hi' }],
    });
    const surface = await runtime.getControlSurface({ sessionID: session.id });
    assert.equal(surface.modelSelector.defaultOptionId, 'deepseek-chat');
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('getSession never resolves a different id from the directory', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    // Unknown id must be null — a directory fallback here would let the route layer
    // re-bind another session (or another backend's session) to this backend.
    assert.equal(await runtime.getSession({ sessionID: 'does-not-exist', directory }), null);
    assert.equal((await runtime.getSession({ sessionID: session.id })).id, session.id);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('an already-encoded model option value reaches dsh verbatim', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const optionValue = JSON.stringify(['deepseek-official', 'deepseek-reasoner']);
    await runtime.prompt({
      sessionID: session.id,
      model: optionValue, // exactly what the picker sends: modelSelector.options[].id
      parts: [{ type: 'text', text: 'hi' }],
    });
    const surface = await runtime.getControlSurface({ sessionID: session.id });
    assert.equal(surface.modelSelector.defaultOptionId, optionValue);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('a second turn on the same session is rejected while one is running', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory });
    const first = runtime.prompt({ sessionID: session.id, parts: [{ type: 'text', text: 'one' }] });
    const second = runtime.prompt({ sessionID: session.id, parts: [{ type: 'text', text: 'two' }] });
    await assert.rejects(second, /already has a running turn/);
    await first;
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('partsToAcpContentBlocks maps text, image and file parts', () => {
  const blocks = partsToAcpContentBlocks([
    { type: 'text', text: 'hello' },
    { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    { type: 'file', path: 'src/a.ts' },
  ]);
  assert.deepEqual(blocks[0], { type: 'text', text: 'hello' });
  assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'AAAA' });
  assert.match(blocks[2].text, /src\/a\.ts/);
});

test('updateSession, fork, share and status surface behave', async () => {
  const { runtime, directory } = await makeRuntime();
  try {
    const session = await runtime.createSession({ directory, title: 'orig' });
    const updated = await runtime.updateSession({ sessionID: session.id, title: 'renamed' });
    assert.equal(updated.title, 'renamed');

    const forked = await runtime.forkSession({ sessionID: session.id });
    assert.ok(forked.id !== session.id);
    assert.equal(forked.directory, directory);

    assert.equal((await runtime.shareSession()).ok, false);
    const status = await runtime.getStatusSnapshot();
    assert.equal(status.backendId, 'deepseek');
    assert.deepEqual(status.busySessions, []);
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('addEventClient writes directory-scoped SSE frames', async () => {
  const { runtime, events, directory } = await makeRuntime();
  try {
    const frames = [];
    const res = {
      write: (chunk) => frames.push(chunk),
      on: () => {},
    };
    runtime.addEventClient(res, directory);
    const session = await runtime.createSession({ directory });
    await runtime.prompt({ sessionID: session.id, directory, parts: [{ type: 'text', text: 'hi' }] });
    assert.ok(frames.some((f) => f.startsWith('data: ')));
    assert.ok(frames.some((f) => f.includes('"type":"message.part.updated"')));
    void events;
  } finally {
    await runtime._appServer.shutdown();
  }
});

test('unavailable binary is reported honestly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-'));
  const runtime = createDeepSeekBackendRuntime({
    crypto: (await import('node:crypto')).default,
    fsPromises: (await import('node:fs')).promises,
    sessionsFilePath: join(directory, 's.json'),
    env: { ...process.env, DEEPSEEK_DSH_BIN: 'definitely-not-a-real-binary-xyz', DEEPSEEK_DSH_ARGS: '' },
  });
  try {
    assert.equal(runtime.isAvailable(), false);
  } finally {
    await runtime._appServer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
