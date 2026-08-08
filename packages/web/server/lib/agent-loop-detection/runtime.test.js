import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildToolFingerprint,
  contentSimilarity,
  detectLoopFromWindow,
  normalizeContent,
} from './fingerprint.js';
import {
  createAgentLoopDetectionRuntime,
  resolveLoopDetectionConfig,
} from './runtime.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const editPart = ({
  sessionID = 'ses_1',
  callID,
  tool = 'edit',
  status = 'completed',
  filePath = 'src/app.ts',
  oldString = 'foo',
  newString = 'bar',
  id,
} = {}) => ({
  id: id ?? `part_${callID}`,
  sessionID,
  messageID: 'msg_1',
  type: 'tool',
  callID,
  tool,
  state: {
    status,
    input: { filePath, oldString, newString },
    ...(status === 'completed' ? { output: 'ok', title: filePath, metadata: {}, time: { start: 1, end: 2 } } : {}),
  },
});

const partUpdated = (part) => ({
  type: 'message.part.updated',
  properties: { part },
});

describe('agent loop fingerprint helpers', () => {
  it('hashes identical edit payloads the same way', () => {
    const left = buildToolFingerprint(editPart({ callID: 'c1', oldString: 'a', newString: 'b' }));
    const right = buildToolFingerprint(editPart({ callID: 'c2', oldString: 'a', newString: 'b' }));
    expect(left.exactHash).toBe(right.exactHash);
    expect(left.path).toBe('src/app.ts');
  });

  it('treats whitespace-only content changes as near-identical via normalized hash', () => {
    const left = buildToolFingerprint(editPart({
      callID: 'c1',
      oldString: 'foo',
      newString: 'hello world',
    }));
    const right = buildToolFingerprint(editPart({
      callID: 'c2',
      oldString: 'foo',
      newString: 'hello   world',
    }));
    expect(left.exactHash).not.toBe(right.exactHash);
    expect(left.normalizedHash).toBe(right.normalizedHash);
    expect(normalizeContent('hello   world')).toBe('hello world');
    expect(contentSimilarity('hello world', 'hello   world')).toBe(1);
  });

  it('detects identical trailing streaks and ignores normal multi-step progress', () => {
    const a = buildToolFingerprint(editPart({ callID: '1', filePath: 'a.ts', newString: 'one' }));
    const b = buildToolFingerprint(editPart({ callID: '2', filePath: 'b.ts', newString: 'two' }));
    const c = buildToolFingerprint(editPart({ callID: '3', filePath: 'a.ts', newString: 'three' }));
    expect(detectLoopFromWindow([a, b, c], { identicalThreshold: 3 })).toBeNull();

    const same = buildToolFingerprint(editPart({ callID: '4', filePath: 'a.ts', newString: 'one' }));
    const same2 = buildToolFingerprint(editPart({ callID: '5', filePath: 'a.ts', newString: 'one' }));
    const same3 = buildToolFingerprint(editPart({ callID: '6', filePath: 'a.ts', newString: 'one' }));
    expect(detectLoopFromWindow([same, same2, same3], { identicalThreshold: 3 })).toMatchObject({
      kind: 'identical',
      count: 3,
      path: 'a.ts',
      tool: 'edit',
    });
  });

  it('detects near-identical trailing edit streaks on the same file', () => {
    const first = buildToolFingerprint(editPart({
      callID: '1',
      filePath: 'loop.ts',
      newString: 'const value = 1;',
    }));
    const second = buildToolFingerprint(editPart({
      callID: '2',
      filePath: 'loop.ts',
      newString: 'const value = 1; ',
    }));
    const third = buildToolFingerprint(editPart({
      callID: '3',
      filePath: 'loop.ts',
      newString: 'const  value = 1;',
    }));
    expect(detectLoopFromWindow([first, second, third], {
      identicalThreshold: 5,
      nearThreshold: 3,
      nearSimilarity: 0.9,
    })).toMatchObject({
      kind: 'near-identical',
      count: 3,
      path: 'loop.ts',
    });
  });
});

describe('resolveLoopDetectionConfig', () => {
  it('uses safe defaults and parses env overrides', () => {
    expect(resolveLoopDetectionConfig({})).toMatchObject({
      enabled: true,
      identicalThreshold: 3,
      nearThreshold: 3,
      behavior: 'auto',
    });
    expect(resolveLoopDetectionConfig({
      OPENCHAMBER_AGENT_LOOP_DETECTION: '0',
      OPENCHAMBER_AGENT_LOOP_THRESHOLD: '4',
      OPENCHAMBER_AGENT_LOOP_BEHAVIOR: 'warn',
    })).toMatchObject({
      enabled: false,
      identicalThreshold: 4,
      nearThreshold: 4,
      behavior: 'warn',
    });
  });
});

describe('agent loop detection runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not intervene during a normal multi-step edit sequence', async () => {
    const fetchImpl = vi.fn();
    const detections = [];
    const runtime = createAgentLoopDetectionRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      onDetection: (event) => detections.push(event),
      config: {
        enabled: true,
        identicalThreshold: 3,
        nearThreshold: 3,
        windowSize: 12,
        nearSimilarity: 0.92,
        behavior: 'auto',
        cooldownMs: 30_000,
      },
    });

    runtime.processPayload(partUpdated(editPart({ callID: 'c1', filePath: 'a.ts', newString: 'one' })), '/repo');
    runtime.processPayload(partUpdated(editPart({ callID: 'c2', filePath: 'b.ts', newString: 'two' })), '/repo');
    runtime.processPayload(partUpdated(editPart({ callID: 'c3', filePath: 'a.ts', newString: 'three' })), '/repo');
    runtime.processPayload(partUpdated({
      id: 'part_c4',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'c4',
      tool: 'write',
      state: {
        status: 'completed',
        input: { filePath: 'c.ts', content: 'export {}' },
        output: 'ok',
        title: 'c.ts',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }), '/repo');

    expect(detections).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('aborts without recovery when identical edits repeat past the threshold', async () => {
    const requests = [];
    const detections = [];
    const logs = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET' });
      if (url.pathname.endsWith('/abort')) return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = createAgentLoopDetectionRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onDetection: (event) => detections.push(event),
      log: { warn: (message) => logs.push(message) },
      config: {
        enabled: true,
        identicalThreshold: 3,
        nearThreshold: 3,
        windowSize: 12,
        nearSimilarity: 0.92,
        behavior: 'auto',
        cooldownMs: 30_000,
      },
    });

    const same = { filePath: 'loop.ts', oldString: 'x', newString: 'y' };
    runtime.processPayload(partUpdated(editPart({ callID: 'c1', ...same })), '/repo');
    runtime.processPayload(partUpdated(editPart({ callID: 'c2', ...same })), '/repo');
    // duplicate callID must not count twice
    runtime.processPayload(partUpdated(editPart({ callID: 'c2', ...same })), '/repo');
    runtime.processPayload(partUpdated(editPart({ callID: 'c3', ...same })), '/repo');

    await vi.waitFor(() => {
      expect(requests.some((request) => request.path.endsWith('/abort'))).toBe(true);
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      action: 'stop',
      detection: { kind: 'identical', count: 3, path: 'loop.ts', tool: 'edit' },
    });
    expect(requests.some((request) => request.path.includes('/prompt_async'))).toBe(false);
    expect(logs.some((line) => line.includes('identical loop detected') && line.includes('action=stop'))).toBe(true);

    // idle with no pending recovery should not prompt
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    }, '/repo');
    await Promise.resolve();
    expect(requests.filter((request) => request.path.includes('/prompt_async'))).toHaveLength(0);
    runtime.stop();
  });

  it('aborts and injects a recovery prompt for near-identical edit loops', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname.endsWith('/abort')) return json({});
      if (url.pathname.endsWith('/message')) {
        return json([
          {
            info: {
              id: 'msg_agent',
              role: 'assistant',
              providerID: 'provider',
              modelID: 'model',
              agent: 'build',
            },
          },
        ]);
      }
      if (url.pathname.endsWith('/prompt_async')) return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));

    const runtime = createAgentLoopDetectionRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      config: {
        enabled: true,
        identicalThreshold: 5,
        nearThreshold: 3,
        windowSize: 12,
        nearSimilarity: 0.9,
        behavior: 'auto',
        cooldownMs: 30_000,
      },
    });

    runtime.processPayload(partUpdated(editPart({
      callID: 'n1',
      filePath: 'near.ts',
      newString: 'const value = 1;',
    })), '/repo');
    runtime.processPayload(partUpdated(editPart({
      callID: 'n2',
      filePath: 'near.ts',
      newString: 'const value = 1; ',
    })), '/repo');
    runtime.processPayload(partUpdated(editPart({
      callID: 'n3',
      filePath: 'near.ts',
      newString: 'const  value = 1;',
    })), '/repo');

    await vi.waitFor(() => {
      expect(requests.some((request) => request.path.endsWith('/abort'))).toBe(true);
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/repo' },
    }, '/repo');

    await vi.waitFor(() => {
      expect(requests.some((request) => request.path.endsWith('/prompt_async'))).toBe(true);
    });

    const prompt = requests.find((request) => request.path.endsWith('/prompt_async'));
    const body = JSON.parse(prompt.body);
    expect(body).toMatchObject({
      model: { providerID: 'provider', modelID: 'model' },
      agent: 'build',
      parts: [{ type: 'text', synthetic: true }],
    });
    expect(body.parts[0].text).toContain('near-identical');
    expect(body.parts[0].text).toContain('near.ts');
    expect(body.parts[0].text).toContain('Change approach');
    runtime.stop();
  });

  it('can be disabled via config / env', () => {
    const fetchImpl = vi.fn();
    const runtime = createAgentLoopDetectionRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      config: {
        enabled: false,
        identicalThreshold: 2,
        nearThreshold: 2,
        windowSize: 12,
        nearSimilarity: 0.92,
        behavior: 'auto',
        cooldownMs: 30_000,
      },
    });

    const same = { filePath: 'x.ts', oldString: 'a', newString: 'b' };
    runtime.processPayload(partUpdated(editPart({ callID: 'd1', ...same })), '/repo');
    runtime.processPayload(partUpdated(editPart({ callID: 'd2', ...same })), '/repo');
    expect(fetchImpl).not.toHaveBeenCalled();
    runtime.stop();
  });
});
