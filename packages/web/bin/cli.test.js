import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';
import { requestJson } from './lib/cli-http.js';
import { inspectTunnelAttachability } from './lib/cli-lifecycle.js';
import { buildTaskPayload, formatGoal } from './lib/commands-schedule.js';
import {
  buildSessionCreatePayload,
  buildSessionPromptPayload,
  buildSessionListEndpoint,
  buildSessionMessagesEndpoint,
  buildSessionStatusEndpoint,
  extractTextMessages,
  filterVisibleSessions,
  formatSessionLine,
  normalizeWaitTimeoutMs,
  resolveSessionStatus,
  sessionCommand,
  waitForSessionIdle,
} from './lib/commands-session.js';
import { formatModelsOutput } from './lib/commands-models.js';
import { formatProjectLine } from './lib/commands-projects.js';
import { normalizeProjects } from './lib/cli-projects.js';
import { resolveTargetPort } from './lib/cli-api-target.js';
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from './lib/cli-tunnel-capabilities.js';
import {
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
} from '../server/lib/tunnels/types.js';
import {
  assertAuthenticatedNetworkExposure,
  assertDesktopShimCommandAllowed,
  commands,
  discoverOpenChamberInstanceOnPort,
  discoverLifecycleInstances,
  discoverRunningInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
  ensureTunnelProfilesMigrated,
  getInstanceFilePath,
  getPidFilePath,
  isOpenchamberCmdline,
  isOpenchamberProcessRunning,
  main,
  parseArgs,
  resolveServeHost,
} from './cli.js';

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (typeof value === 'string') {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
  try {
    return fn();
  } finally {
    if (typeof previous === 'string') {
      process.env[name] = previous;
    } else {
      delete process.env[name];
    }
  }
}

async function withArgv(argv, fn) {
  const previous = process.argv;
  process.argv = ['node', 'openchamber', ...argv];
  try {
    return await fn();
  } finally {
    process.argv = previous;
  }
}

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cli-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockJsonResponse(body, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, callback) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureConsoleLog(fn) {
  const originalLog = console.log;
  let output = '';
  console.log = (...args) => {
    output += `${args.join(' ')}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return output;
}

async function startMockOpenChamberServer(options = {}) {
  const runtime = options.runtime || 'web';
  const pid = Number.isFinite(options.pid) ? options.pid : null;
  let shutdownRequested = false;
  let closed = false;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/system/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runtime, pid }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/system/shutdown') {
      shutdownRequested = true;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
      try {
        server.close(() => {
          closed = true;
        });
      } catch {
        closed = true;
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    get shutdownRequested() {
      return shutdownRequested;
    },
    close: async () => {
      if (closed || !server.listening) return;
      await new Promise((resolve) => {
        try {
          server.close(() => {
            closed = true;
            resolve();
          });
        } catch {
          closed = true;
          resolve();
        }
      });
    },
  };
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForTcpPort(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function spawnOpenChamberLikeIdleProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'openchamber-idle'], { stdio: 'ignore' });
}

function spawnOpenChamberLikeHungServer(port) {
  const script = `
    const net = require('net');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', script, 'openchamber-hung-server'], { stdio: 'ignore' });
}

describe('cli args', () => {
  it('loads fallback tunnel provider capabilities for CLI startup', () => {
    expect(DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.map((provider) => provider.provider)).toEqual([
      TUNNEL_PROVIDER_CLOUDFLARE,
      TUNNEL_PROVIDER_NGROK,
    ]);
  });

  it('accepts legacy daemon flags as no-ops', () => {
    expect(parseArgs(['serve', '--daemon']).removedFlagErrors).toEqual([]);
    expect(parseArgs(['serve', '-d']).removedFlagErrors).toEqual([]);
  });

  it('parses explicit connect-url server overrides', () => {
    const parsed = parseArgs(['connect-url', '--server', 'https://openchamber.example.com', '--port', '3002']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.server).toBe('https://openchamber.example.com');
    expect(parsed.options.port).toBe(3002);
  });

  it('parses connect-url server-url alias', () => {
    const parsed = parseArgs(['connect-url', '--server-url=http://homebridge:3002']);

    expect(parsed.options.server).toBe('http://homebridge:3002');
  });

  it('parses connect-url --relay flag', () => {
    const parsed = parseArgs(['connect-url', '--relay', '--name', 'My laptop']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.relay).toBe(true);
    expect(parsed.options.name).toBe('My laptop');
  });

  it('parses connect-url api-only help', () => {
    const parsed = parseArgs(['connect-url', '--api-only', '--help']);

    expect(parsed.command).toBe('connect-url');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses startup api-only option', () => {
    const parsed = parseArgs(['startup', 'enable', '--api-only', '--port', '3002']);

    expect(parsed.command).toBe('startup');
    expect(parsed.startupAction).toBe('enable');
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.port).toBe(3002);
  });

  it('parses schedule commands and options', () => {
    const parsed = parseArgs([
      'schedule',
      'create',
      '--project',
      'proj_1',
      '--name',
      'Daily review',
      '--prompt',
      'Review the repo',
      '--model',
      'openai/gpt-5.5',
      '--daily',
      '09:30',
      '--timezone',
      'Europe/Kyiv',
    ]);

    expect(parsed.command).toBe('schedule');
    expect(parsed.scheduleAction).toBe('create');
    expect(parsed.options.project).toBe('proj_1');
    expect(parsed.options.name).toBe('Daily review');
    expect(parsed.options.prompt).toBe('Review the repo');
    expect(parsed.options.model).toBe('openai/gpt-5.5');
    expect(parsed.options.daily).toBe('09:30');
    expect(parsed.options.timezone).toBe('Europe/Kyiv');
  });

  it('builds scheduled task payloads from CLI options', () => {
    const payload = buildTaskPayload({
      name: 'Daily review',
      prompt: 'Review the repo',
      model: 'openai/gpt-5.5',
      daily: '09:30',
      timezone: 'Europe/Kyiv',
      agent: 'build',
    });

    expect(payload).toEqual({
      name: 'Daily review',
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'Europe/Kyiv',
      },
      execution: {
        prompt: 'Review the repo',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        agent: 'build',
      },
    });
  });

  it('builds goal-enabled scheduled task payloads', () => {
    const parsed = parseArgs([
      'schedule',
      'create',
      '--dir',
      '/repo',
      '--name',
      'Finish migration',
      '--prompt',
      'Complete and verify the migration',
      '--model',
      'openai/gpt-5.5',
      '--daily',
      '09:30',
      '--goal',
      '--goal-token-budget',
      '200000',
    ]);

    expect(parsed.options.goal).toBe(true);
    expect(parsed.options.goalTokenBudget).toBe('200000');
    expect(buildTaskPayload(parsed.options).execution).toEqual({
      prompt: 'Complete and verify the migration',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      goalEnabled: true,
      goalTokenBudget: 200000,
    });
  });

  it('validates scheduled goal token budgets', () => {
    const base = {
      name: 'Goal task',
      prompt: 'Complete the goal',
      model: 'openai/gpt-5.5',
      daily: '09:30',
    };

    expect(() => buildTaskPayload({ ...base, goalTokenBudget: '200000' })).toThrow('--goal-token-budget requires --goal.');
    for (const value of ['0', '-1', '999', '1.5', '100000001', 'nope']) {
      expect(() => buildTaskPayload({ ...base, goal: true, goalTokenBudget: value })).toThrow(
        '--goal-token-budget must be an integer from 1000 to 100000000.',
      );
    }
  });

  it('formats scheduled goal state compactly', () => {
    expect(formatGoal({})).toBe('goal:no');
    expect(formatGoal({ goalEnabled: true })).toBe('goal:yes');
    expect(formatGoal({ goalEnabled: true, goalTokenBudget: 200000 })).toBe('goal:yes budget:200000');
  });

  it('rejects ambiguous scheduled task schedule selectors', () => {
    expect(() => buildTaskPayload({
      name: 'Bad schedule',
      prompt: 'Run',
      model: 'openai/gpt-5.5',
      daily: '09:30',
      cron: '* * * * *',
    })).toThrow('Provide exactly one of --daily, --weekly, --once, or --cron.');
  });

  it('parses session create options', () => {
    const parsed = parseArgs([
      'session',
      'create',
      '--dir',
      '.',
      '--name',
      'Side task',
      '--prompt',
      'Investigate cache invalidation',
      '--model',
      'openai/gpt-5.5',
      '--worktree',
      'side-task',
      '--branch',
      'openchamber/side-task',
      '--base',
      'main',
      '--no-upstream',
    ]);

    expect(parsed.command).toBe('session');
    expect(parsed.sessionAction).toBe('create');
    expect(parsed.options.directory).toBe('.');
    expect(parsed.options.name).toBe('Side task');
    expect(parsed.options.prompt).toBe('Investigate cache invalidation');
    expect(parsed.options.model).toBe('openai/gpt-5.5');
    expect(parsed.options.worktree).toBe('side-task');
    expect(parsed.options.branch).toBe('openchamber/side-task');
    expect(parsed.options.startRef).toBe('main');
    expect(parsed.options.setUpstream).toBe(false);
  });

  it('parses control help command', () => {
    const parsed = parseArgs(['control', 'help']);
    expect(parsed.command).toBe('control');
    expect(parsed.controlAction).toBe('help');
  });

  it('builds session create payloads from CLI options', () => {
    expect(buildSessionCreatePayload({
      directory: '.',
      name: 'Side task',
      prompt: 'Investigate cache invalidation',
      model: 'openai/gpt-5.5',
      agent: 'build',
      worktree: 'side-task',
      branch: 'openchamber/side-task',
      startRef: 'main',
      setUpstream: true,
    })).toEqual({
      directory: '.',
      title: 'Side task',
      worktree: {
        name: 'side-task',
        branchName: 'openchamber/side-task',
        startRef: 'main',
      },
      prompt: 'Investigate cache invalidation',
      model: 'openai/gpt-5.5',
      agent: 'build',
      setUpstream: true,
    });
  });

  it('allows session create prompts without an explicit model', () => {
    expect(buildSessionCreatePayload({
      directory: '.',
      prompt: 'Investigate cache invalidation',
    })).toEqual({
      directory: '.',
      prompt: 'Investigate cache invalidation',
    });
  });

  it('builds goal-enabled session create payloads', () => {
    const parsed = parseArgs([
      'session',
      'create',
      '--dir',
      '/repo',
      '--prompt',
      'Finish and verify the migration',
      '--goal',
      '--goal-token-budget',
      '200000',
    ]);

    expect(buildSessionCreatePayload(parsed.options)).toEqual({
      directory: '/repo',
      prompt: 'Finish and verify the migration',
      goal: true,
      goalTokenBudget: 200000,
    });
  });

  it('validates session goal options before HTTP', () => {
    expect(() => buildSessionCreatePayload({ directory: '/repo', goal: true })).toThrow('--goal requires --prompt.');
    expect(() => buildSessionCreatePayload({
      directory: '/repo',
      prompt: 'Run',
      goalTokenBudget: '200000',
    })).toThrow('--goal-token-budget requires --goal.');
    for (const value of ['999', '1.5', '100000001', 'nope']) {
      expect(() => buildSessionCreatePayload({
        directory: '/repo',
        prompt: 'Run',
        goal: true,
        goalTokenBudget: value,
      })).toThrow('--goal-token-budget must be an integer from 1000 to 100000000.');
    }
  });

  it('parses session list filters', () => {
    const parsed = parseArgs(['session', 'list', '--dir', '/repo', '--limit', '5']);

    expect(parsed.command).toBe('session');
    expect(parsed.sessionAction).toBe('list');
    expect(parsed.options.directory).toBe('/repo');
    expect(parsed.options.limit).toBe(5);
    expect(buildSessionListEndpoint(parsed.options)).toBe('/api/session?directory=%2Frepo');
  });

  it('parses session status and message options', () => {
    const status = parseArgs(['session', 'status', '--session', 'ses_123', '--dir', '/repo']);
    expect(status.sessionAction).toBe('status');
    expect(status.options.session).toBe('ses_123');
    expect(status.options.directory).toBe('/repo');

    const messages = parseArgs([
      'session',
      'messages',
      '--session',
      'ses_123',
      '--dir',
      '/repo',
      '--last',
      '--role',
      'assistant',
    ]);
    expect(messages.sessionAction).toBe('messages');
    expect(messages.options.last).toBe(true);
    expect(messages.options.role).toBe('assistant');

    const waiting = parseArgs([
      'session',
      'messages',
      '--session',
      'ses_123',
      '--dir',
      '/repo',
      '--wait',
      '--timeout',
      '30',
      '--last-assistant',
    ]);
    expect(waiting.options.wait).toBe(true);
    expect(waiting.options.timeout).toBe('30');
    expect(waiting.options.lastAssistant).toBe(true);

    const list = parseArgs(['session', 'list', '--dir', '/repo', '--with-status']);
    expect(list.options.withStatus).toBe(true);
  });

  it('parses session send and fork actions', () => {
    const send = parseArgs([
      'session', 'send', '--session', 'ses_123', '--dir', '/repo', '--prompt', 'Continue',
      '--goal', '--wait', '--last-assistant',
    ]);
    expect(send.sessionAction).toBe('send');
    expect(send.options).toMatchObject({
      session: 'ses_123',
      directory: '/repo',
      prompt: 'Continue',
      goal: true,
      wait: true,
      lastAssistant: true,
    });

    const fork = parseArgs([
      'session', 'fork', '--session', 'ses_123', '--dir', '/repo', '--message', 'msg_123',
      '--prompt', 'Try another approach',
    ]);
    expect(fork.sessionAction).toBe('fork');
    expect(fork.options.message).toBe('msg_123');
  });

  it('builds session send and fork prompt payloads', () => {
    expect(buildSessionPromptPayload({
      session: 'ses_123',
      directory: '/repo',
      prompt: 'Continue',
      model: 'openai/gpt-5.5',
      agent: 'build',
      goal: true,
      goalTokenBudget: '200000',
    }, 'send')).toEqual({
      directory: '/repo',
      prompt: 'Continue',
      model: 'openai/gpt-5.5',
      agent: 'build',
      goal: true,
      goalTokenBudget: 200000,
    });
    expect(buildSessionPromptPayload({
      session: 'ses_123',
      directory: '/repo',
      message: 'msg_123',
      prompt: 'Try another approach',
    }, 'fork')).toEqual({
      directory: '/repo',
      messageId: 'msg_123',
      prompt: 'Try another approach',
    });
  });

  it('builds directory-scoped session read endpoints', () => {
    expect(buildSessionStatusEndpoint('/repo worktree')).toBe('/api/session/status?directory=%2Frepo+worktree');
    expect(buildSessionMessagesEndpoint('ses_123', '/repo worktree', 10)).toBe(
      '/api/session/ses_123/message?directory=%2Frepo+worktree&limit=10',
    );
    expect(buildSessionMessagesEndpoint('ses_123', '/repo', undefined)).toBe(
      '/api/session/ses_123/message?directory=%2Frepo',
    );
  });

  it('resolves omitted successful statuses as idle', () => {
    expect(resolveSessionStatus({}, 'ses_idle')).toEqual({ type: 'idle' });
    expect(resolveSessionStatus({ ses_busy: { type: 'busy' } }, 'ses_busy')).toEqual({ type: 'busy' });
    expect(resolveSessionStatus(null, 'ses_unknown')).toBeNull();
  });

  it('projects only ordered text parts from session messages', () => {
    const messages = extractTextMessages([
      {
        info: { id: 'msg_assistant', role: 'assistant', providerID: 'openai', modelID: 'gpt-5.4-mini', time: { created: 20, completed: 30 } },
        parts: [
          { type: 'reasoning', text: 'hidden reasoning' },
          { type: 'text', text: 'First ' },
          { type: 'tool', state: {} },
          { type: 'text', text: 'answer' },
        ],
      },
      {
        info: { id: 'msg_user', role: 'user', time: { created: 10 } },
        parts: [{ type: 'text', text: 'Question' }],
      },
      {
        info: { id: 'msg_tool_only', role: 'assistant', time: { created: 15 } },
        parts: [{ type: 'tool', state: {} }],
      },
    ]);

    expect(messages).toEqual([
      { id: 'msg_user', role: 'user', createdAt: 10, completedAt: null, model: null, text: 'Question' },
      {
        id: 'msg_assistant',
        role: 'assistant',
        createdAt: 20,
        completedAt: 30,
        model: 'openai/gpt-5.4-mini',
        text: 'First answer',
      },
    ]);
    expect(extractTextMessages([
      { info: { id: 'msg_user', role: 'user', time: { created: 10 } }, parts: [{ type: 'text', text: 'Question' }] },
    ], 'assistant')).toEqual([]);
  });

  it('validates session message selectors before HTTP', async () => {
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo', all: true, last: true }, 'messages'))
      .rejects.toThrow('--all cannot be combined with --last or --limit.');
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo', role: 'tool' }, 'messages'))
      .rejects.toThrow('--role must be one of: all, user, assistant.');
    await expect(sessionCommand({ session: 'ses_123' }, 'status'))
      .rejects.toThrow('Missing required --dir.');
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo', timeout: '30' }, 'messages'))
      .rejects.toThrow('--timeout requires --wait.');
    await expect(sessionCommand({ directory: '/repo', lastAssistant: true }, 'create'))
      .rejects.toThrow('--last-assistant requires --wait for session create.');
    await expect(sessionCommand({ directory: '/repo', timeout: '30' }, 'create'))
      .rejects.toThrow('--timeout requires --wait.');
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo' }, 'send'))
      .rejects.toThrow('Missing required --prompt.');
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo', prompt: 'Run', message: 'msg_1' }, 'send'))
      .rejects.toThrow('--message is only valid for session fork.');
    await expect(sessionCommand({ session: 'ses_123', directory: '/repo', prompt: 'Run', lastAssistant: true }, 'fork'))
      .rejects.toThrow('--last-assistant requires --wait for session fork.');
  });

  it('validates session wait timeout seconds', () => {
    expect(normalizeWaitTimeoutMs(undefined)).toBe(600_000);
    expect(normalizeWaitTimeoutMs('30')).toBe(30_000);
    for (const value of ['0', '1.5', 'nope', '86401']) {
      expect(() => normalizeWaitTimeoutMs(value)).toThrow();
    }
  });

  it('waits through active status until the session becomes idle', async () => {
    const statuses = [{ type: 'busy' }, { type: 'retry' }, { type: 'idle' }];
    let elapsed = 0;
    await expect(waitForSessionIdle({
      timeoutMs: 10_000,
      fetchStatus: async () => statuses.shift(),
      now: () => elapsed,
      wait: async (duration) => { elapsed += duration; },
    })).resolves.toEqual({ type: 'idle' });
  });

  it('does not accept initial idle for a newly dispatched prompt without completion evidence', async () => {
    let elapsed = 0;
    let completionChecks = 0;
    await expect(waitForSessionIdle({
      timeoutMs: 10_000,
      requireActivity: true,
      fetchStatus: async () => ({ type: 'idle' }),
      hasCompletedResult: async () => {
        completionChecks += 1;
        return completionChecks >= 2;
      },
      now: () => elapsed,
      wait: async (duration) => { elapsed += duration; },
    })).resolves.toEqual({ type: 'idle' });
    expect(completionChecks).toBe(2);
  });

  it('fails a session wait after its deadline', async () => {
    let elapsed = 0;
    await expect(waitForSessionIdle({
      timeoutMs: 1_000,
      fetchStatus: async () => ({ type: 'busy' }),
      now: () => elapsed,
      wait: async (duration) => { elapsed += duration; },
    })).rejects.toThrow('Session did not become idle within 1 seconds.');
  });

  it('parses models command', () => {
    const parsed = parseArgs(['models', '--json']);

    expect(parsed.command).toBe('models');
    expect(parsed.options.json).toBe(true);
  });

  it('parses projects command', () => {
    const parsed = parseArgs(['projects', '--json']);

    expect(parsed.command).toBe('projects');
    expect(parsed.options.json).toBe(true);
  });

  it('formats projects compactly', () => {
    expect(formatProjectLine({
      id: 'path_repo',
      label: 'Openchamber',
      path: '/repo/openchamber',
    })).toBe('- `Openchamber` — `path_repo` — `/repo/openchamber`');
  });

  it('normalizes projects from settings', () => {
    expect(normalizeProjects({ projects: [
      { id: 'path_repo', label: 'Openchamber', path: '/repo/openchamber' },
      { id: '', path: '/missing/id' },
    ] })).toEqual([{ id: 'path_repo', label: 'Openchamber', path: '/repo/openchamber' }]);
  });

  it('formats model defaults and favorites compactly', () => {
    expect(formatModelsOutput({
      defaultModel: 'opencode-go/deepseek-v4-flash',
      defaultAgent: 'build',
      favoriteModels: [
        { providerID: 'openai', modelID: 'gpt-5.5' },
        { providerID: 'opencode-go', modelID: 'deepseek-v4-pro' },
      ],
      recentModels: [
        { providerID: 'zai-coding-plan', modelID: 'glm-5.2' },
      ],
    })).toBe('Default: `opencode-go/deepseek-v4-flash` / `build`\n\nFavorites:\n- `openai/gpt-5.5`\n- `opencode-go/deepseek-v4-pro`\n\nRecent:\n- `zai-coding-plan/glm-5.2`\n');
  });

  it('formats compact session list lines', () => {
    expect(formatSessionLine({
      title: 'CLI shim changed default smoke',
      agent: 'build',
      directory: '/repo',
      model: { providerID: 'opencode-go', id: 'deepseek-v4-flash', variant: 'default' },
    })).toBe('- `CLI shim changed default smoke` — `opencode-go/deepseek-v4-flash`, `build` — `/repo`');
    expect(formatSessionLine({
      title: 'Working session',
      agent: 'build',
      directory: '/repo',
      model: { providerID: 'openai', id: 'gpt-5.4-mini' },
      status: { type: 'busy' },
    })).toContain('status:busy');
  });

  it('excludes archived sessions by default', () => {
    const sessions = [
      { id: 'active', time: {} },
      { id: 'archived', time: { archived: 123 } },
      { id: 'missing-time' },
    ];

    expect(filterVisibleSessions(sessions).map((session) => session.id)).toEqual(['active', 'missing-time']);
    expect(filterVisibleSessions(sessions, { all: true }).map((session) => session.id)).toEqual(['active', 'archived', 'missing-time']);
  });

  it('parses tunnel auto-start server options', () => {
    const parsed = parseArgs(['tunnel', 'start', '--port', '3002', '--api-only', '--lan', '--ui-password', 'secret']);

    expect(parsed.command).toBe('tunnel');
    expect(parsed.subcommand).toBe('start');
    expect(parsed.options.port).toBe(3002);
    expect(parsed.options.apiOnly).toBe(true);
    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.uiPassword).toBe('secret');
  });

  it('maps --lan to wildcard bind host', () => {
    const parsed = parseArgs(['serve', '--lan', '--port', '3002']);

    expect(parsed.options.host).toBe('0.0.0.0');
    expect(parsed.options.lan).toBe(true);
  });

  it('supports --hostname as top-level bind alias', () => {
    const parsed = parseArgs(['serve', '--hostname', '0.0.0.0']);

    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('keeps --hostname for tunnel commands', () => {
    const parsed = parseArgs(['tunnel', 'start', '--hostname', 'app.example.com']);

    expect(parsed.options.hostname).toBe('app.example.com');
    expect(parsed.options.host).toBeUndefined();
  });
});

describe('desktop CLI shim guard', () => {
  it('blocks standalone server commands from the desktop-installed shim', () => {
    withEnv('OPENCHAMBER_DESKTOP_CLI_SHIM', '1', () => {
      expect(() => assertDesktopShimCommandAllowed('serve')).toThrow('desktop-installed CLI controls the running OpenChamber Desktop app');
      expect(() => assertDesktopShimCommandAllowed('session')).not.toThrow();
      expect(() => assertDesktopShimCommandAllowed('schedule')).not.toThrow();
      expect(() => assertDesktopShimCommandAllowed('models')).not.toThrow();
      expect(() => assertDesktopShimCommandAllowed('projects')).not.toThrow();
      expect(() => assertDesktopShimCommandAllowed('status')).not.toThrow();
    });
  });

  it('shows command-specific help from the desktop-installed shim', async () => {
    const previous = process.env.OPENCHAMBER_DESKTOP_CLI_SHIM;
    process.env.OPENCHAMBER_DESKTOP_CLI_SHIM = '1';
    try {
      const output = await withArgv(['session', '--help'], () => captureStdout(() => main()));

      expect(output).toContain('OpenChamber Session Commands');
      expect(output).not.toContain('OpenChamber Control Commands');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_DESKTOP_CLI_SHIM = previous;
      } else {
        delete process.env.OPENCHAMBER_DESKTOP_CLI_SHIM;
      }
    }
  });

  it('keeps connect-url out of desktop control help', async () => {
    const previous = process.env.OPENCHAMBER_DESKTOP_CLI_SHIM;
    process.env.OPENCHAMBER_DESKTOP_CLI_SHIM = '1';
    try {
      const output = await withArgv(['--help'], () => captureConsoleLog(() => main()));

      expect(output).toContain('OpenChamber Control Commands');
      expect(output).not.toContain('connect-url');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_DESKTOP_CLI_SHIM = previous;
      } else {
        delete process.env.OPENCHAMBER_DESKTOP_CLI_SHIM;
      }
    }
  });
});

describe('cli API target resolution', () => {
  it('uses an explicit port without discovery', async () => {
    await expect(resolveTargetPort(
      { explicitPort: true, port: 4567 },
      {
        discoverDesktopInstance: async () => { throw new Error('should not discover desktop'); },
        discoverLifecycleInstances: async () => { throw new Error('should not discover lifecycle'); },
      },
    )).resolves.toBe(4567);
  });

  it('prefers a desktop instance when no port is explicit', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => ({ port: 4500 }),
      discoverLifecycleInstances: async () => [{ port: 3001 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(4500);
  });

  it('uses the only discovered lifecycle instance', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3002 }],
      isServerHealthReady: async () => false,
    })).resolves.toBe(3002);
  });

  it('uses healthy default port when discovery finds no instances', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [],
      isServerHealthReady: async (port) => port === 3000,
    })).resolves.toBe(3000);
  });

  it('fails when multiple non-default instances are running', async () => {
    await expect(resolveTargetPort({}, {
      discoverDesktopInstance: async () => null,
      discoverLifecycleInstances: async () => [{ port: 3001 }, { port: 3002 }],
      isServerHealthReady: async () => false,
    })).rejects.toThrow('Multiple OpenChamber instances are running');
  });
});

describe('network-exposed auth validation', () => {
  it('allows loopback without a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '127.0.0.1' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: 'localhost' })).not.toThrow();
    expect(() => assertAuthenticatedNetworkExposure({ host: '::1' })).not.toThrow();
  });

  it('requires a UI password for LAN and wildcard bind hosts', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).toThrow(/refuses to bind/);
    expect(() => assertAuthenticatedNetworkExposure({ host: '192.168.1.10' })).toThrow(/refuses to bind/);
  });

  it('allows network-exposed bind hosts with a UI password', () => {
    expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0', uiPassword: 'secret' })).not.toThrow();
  });

  it('allows explicit unsafe LAN override from process env only', () => {
    const previous = process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
    process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = 'true';
    try {
      expect(() => assertAuthenticatedNetworkExposure({ host: '0.0.0.0' })).not.toThrow();
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN = previous;
      } else {
        delete process.env.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN;
      }
    }
  });
});

describe('serve host resolution', () => {
  it('uses OPENCHAMBER_HOST when --host is not provided', () => {
    const previous = process.env.OPENCHAMBER_HOST;
    process.env.OPENCHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost(undefined)).toBe('192.0.2.20');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_HOST = previous;
      } else {
        delete process.env.OPENCHAMBER_HOST;
      }
    }
  });

  it('prefers explicit --host over OPENCHAMBER_HOST', () => {
    const previous = process.env.OPENCHAMBER_HOST;
    process.env.OPENCHAMBER_HOST = '192.0.2.20';
    try {
      expect(resolveServeHost('192.0.2.21')).toBe('192.0.2.21');
    } finally {
      if (typeof previous === 'string') {
        process.env.OPENCHAMBER_HOST = previous;
      } else {
        delete process.env.OPENCHAMBER_HOST;
      }
    }
  });
});

describe('compatibility exports', () => {
  it('allows tunnel profile migration before command options are initialized', async () => {
    await withTempOpenChamberDataDir(async () => {
      const store = ensureTunnelProfilesMigrated();

      expect(store).toEqual({ version: 1, profiles: [] });
    });
  });

  it('includes ngrok in fallback tunnel providers when no server is reachable', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const output = await captureStdout(async () => {
        await commands.tunnel({ json: true, explicitPort: true, port }, 'providers');
      });

      const body = JSON.parse(output);
      expect(body.source).toBe('fallback');
      expect(body.providers.map((entry) => entry.provider)).toContain('ngrok');
    });
  });

  it('supports ngrok quick dry-run with an explicit port', async () => {
    await withTempOpenChamberDataDir(async () => {
      const output = await captureStdout(async () => {
        await commands.tunnel({
          json: true,
          dryRun: true,
          explicitPort: true,
          port: 3003,
          provider: 'ngrok',
          mode: 'quick',
        }, 'start');
      });

      const body = JSON.parse(output);
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        dryRun: true,
        provider: 'ngrok',
        mode: 'quick',
      }));
    });
  });
});

describe('CLI HTTP helpers', () => {
  it('retries UI-authenticated API requests with the stored instance password', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45678;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(options.body)).toEqual({ password: 'secret' });
          return {
            ok: true,
            headers: { get: (name) => name.toLowerCase() === 'set-cookie' ? 'oc_ui_session=session-token; Path=/; HttpOnly' : null },
            json: async () => ({ authenticated: true }),
          };
        }
        if (options.headers?.Cookie === 'oc_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      };

      try {
        const { response, body } = await requestJson(port, '/api/openchamber/tunnel/start', {
          method: 'POST',
          body: JSON.stringify({ provider: 'ngrok', mode: 'quick' }),
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
          '/api/openchamber/tunnel/start',
          '/auth/session',
          '/api/openchamber/tunnel/start',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('prefers the stored instance password over a non-explicit env password', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45679;
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, uiPassword: 'stored-secret' }, null, 2));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/auth/session')) {
          expect(JSON.parse(options.body)).toEqual({ password: 'stored-secret' });
          return {
            ok: true,
            headers: { getSetCookie: () => ['oc_ui_session=session-token; Path=/; HttpOnly'] },
            json: async () => ({ authenticated: true }),
          };
        }
        if (options.headers?.Cookie === 'oc_ui_session=session-token') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UI authentication required', locked: true }),
        };
      };

      try {
        const { response, body } = await requestJson(port, '/api/openchamber/scheduled-tasks/status', {
          uiPassword: 'stale-env-secret',
          explicitUiPassword: false,
        });

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('authenticates desktop-local API requests with the stored client token', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      const port = 57123;
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
        desktopLocalPort: port,
        desktopLocalClientToken: 'oc_client_test',
      }, null, 2));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, options = {}) => {
        if (options.headers?.Authorization === 'Bearer oc_client_test') {
          return createMockJsonResponse({ ok: true });
        }
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Client authentication required', locked: true }),
        };
      };

      try {
        const { response, body } = await requestJson(port, '/api/openchamber/scheduled-tasks/status');

        expect(response.ok).toBe(true);
        expect(body).toEqual({ ok: true });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('cli entry detection', () => {
  const modulePath = '/tmp/openchamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/openchamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/openchamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'openchamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});

describe('isOpenchamberCmdline', () => {
  it('accepts OpenChamber CLI and daemon cmdlines', () => {
    expect(isOpenchamberCmdline('node /x/@openchamber/web/bin/cli.js serve')).toBe(true);
    expect(isOpenchamberCmdline('node /x/@openchamber/web/server/index.js --port 9090')).toBe(true);
    expect(isOpenchamberCmdline('bun /home/u/projects/openchamber/packages/web/server/index.js --port 3001')).toBe(true);
  });

  it('rejects recycled and unrelated processes (issue #1721)', () => {
    expect(isOpenchamberCmdline('node /home/herjarsa/npm-global/bin/agentmemory')).toBe(false);
    expect(isOpenchamberCmdline('node /usr/lib/node_modules/npm/bin/npm-cli.js install')).toBe(false);
    expect(isOpenchamberCmdline('')).toBe(false);
    expect(isOpenchamberCmdline(null)).toBe(false);
  });
});

describe('isOpenchamberProcessRunning', () => {
  it('returns false for a dead PID', () => {
    expect(isOpenchamberProcessRunning(2147483646)).toBe(false);
  });

  // Identity verification is available on Linux (/proc) and macOS (ps); on those
  // platforms a live but unrelated process (a recycled stale PID) must read as
  // not-running so it can't trip the "already running" guard (issue #1721).
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'returns false for a live non-OpenChamber PID',
    async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(isOpenchamberProcessRunning(child.pid)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    }
  );
});

describe('lifecycle instance discovery', () => {
  it('does not attribute a desktop runtime response to a different explicit port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverOpenChamberInstanceOnPort(3003, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toBeNull();
    });
  });

  it('attributes a desktop runtime response to its configured desktop port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));

      const instance = await discoverOpenChamberInstanceOnPort(57123, {
        fetchImpl: async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 }),
      });

      expect(instance).toEqual(expect.objectContaining({
        port: 57123,
        pid: 934,
        runtime: 'desktop',
      }));
    });
  });

  it('does not mark tunnel attachability as desktop for a different explicit port', async () => {
    await withTempOpenChamberDataDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ desktopLocalPort: 57123 }, null, 2));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => createMockJsonResponse({ runtime: 'desktop', pid: 934 });
      try {
        const attachability = await inspectTunnelAttachability(3004, { requireHealthy: false });

        expect(attachability.reason).not.toBe('desktop');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('keeps pid and instance files when live port probe confirms a cmdline mismatch', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45123;
      const pid = 12345;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon', startedAt: 123 }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid }),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('removes stale pid and instance files when a cmdline mismatch is not confirmed by live probe', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45124;
      const pid = 12346;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'mismatched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(instanceFile)).toBe(false);
    });
  });

  it('preserves matched pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45126;
      const pid = 12347;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('preserves unknown-identity pid and instance files when the recorded port probe is inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45129;
      const pid = 12350;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse(null, false),
        getOpenchamberProcessState: () => 'unknown',
      });

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('uses the live system-info pid instead of a stale OpenChamber-looking pid-file pid', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45127;
      const stalePid = 12348;
      const livePid = 54321;
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(stalePid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverRunningInstances({
        fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: livePid }),
        getOpenchamberProcessState: () => 'matched',
      });

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: livePid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('uses the explicit host when probing a pid-file entry without a stored host', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45128;
      const pid = 12349;
      const host = '192.0.2.10';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return createMockJsonResponse({ runtime: 'web', pid });
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
      expect(new URL(urls[0]).hostname).toBe(host);
    });
  });

  it('tries loopback before treating an explicit-host pid-file probe as inconclusive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45130;
      const pid = 12351;
      const host = '192.0.2.11';
      const urls = [];
      fs.writeFileSync(await getPidFilePath(port), String(pid));
      fs.writeFileSync(await getInstanceFilePath(port), JSON.stringify({ port, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            urls.push(String(url));
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(urls.map((url) => new URL(url).hostname)).toContain(host);
      expect(urls.map((url) => new URL(url).hostname)).toContain('127.0.0.1');
      expect(instances).toEqual([
        expect.objectContaining({ port, pid, runtime: 'web', source: 'registry+probe' }),
      ]);
    });
  });

  it('does not accept a fallback loopback probe with a different pid for a concrete host registry', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45131;
      const pid = 12352;
      const otherPid = 54322;
      const host = '192.0.2.12';
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      fs.writeFileSync(pidFile, String(pid));
      fs.writeFileSync(instanceFile, JSON.stringify({ port, host, launchMode: 'daemon' }, null, 2));

      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port, host },
        {
          fetchImpl: async (url) => {
            return new URL(String(url)).hostname === '127.0.0.1'
              ? createMockJsonResponse({ runtime: 'web', pid: otherPid })
              : createMockJsonResponse(null, false);
          },
          getOpenchamberProcessState: () => 'matched',
        },
      );

      expect(instances).toEqual([]);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(instanceFile)).toBe(true);
    });
  });

  it('discovers an explicit live OpenChamber port without a pid-file registry entry', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = 45125;
      const instances = await discoverLifecycleInstances(
        { explicitPort: true, port },
        { fetchImpl: async () => createMockJsonResponse({ runtime: 'web', pid: null }) },
      );

      expect(instances).toEqual([
        expect.objectContaining({ port, pid: null, runtime: 'web', source: 'probe' }),
      ]);
    });
  });

  it('cleans a matched pid-file entry without stopping it when the recorded port is free', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnOpenChamberLikeIdleProcess();
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        const instance = await discoverUnconfirmedRegistryInstanceOnPort(port, { host: '127.0.0.1' });

        expect(instance).toBeNull();
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

describe('lifecycle commands with unmanaged explicit ports', () => {
  it('serve refuses to start on a live OpenChamber port without requiring pid files', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        await expect(commands.serve({ explicitPort: true, port: server.port, quiet: true })).rejects.toThrow(
          /already running on port/
        );
      } finally {
        await server.close();
      }
    });
  });

  it('status --port reports a live unmanaged server when the registry is empty', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        const output = await captureStdout(() => commands.status({ explicitPort: true, port: server.port, json: true }));
        const payload = JSON.parse(output);
        expect(payload.state).toBe('running');
        expect(payload.runningCount).toBe(1);
        expect(payload.instances).toEqual([
          expect.objectContaining({ runtime: 'unmanaged', port: server.port, pid: null }),
        ]);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port reaches unmanaged shutdown when the registry is empty', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      try {
        await commands.stop({ explicitPort: true, port: server.port, quiet: true, suppressQuietOutput: true });
        expect(server.shutdownRequested).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('stop --port can recover a matched pid-file instance whose HTTP endpoint is unresponsive', async () => {
    await withTempOpenChamberDataDir(async () => {
      const port = await allocateLoopbackPort();
      const child = spawnOpenChamberLikeHungServer(port);
      const pidFile = await getPidFilePath(port);
      const instanceFile = await getInstanceFilePath(port);
      try {
        expect(await waitForTcpPort(port)).toBe(true);
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port, host: '127.0.0.1', launchMode: 'daemon' }, null, 2));

        await commands.stop({ explicitPort: true, port, host: '127.0.0.1', quiet: true, suppressQuietOutput: true });

        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  it('plain stop ignores a stale CLI registry entry that resolves to desktop runtime', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer({ runtime: 'desktop' });
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      const pidFile = await getPidFilePath(server.port);
      const instanceFile = await getInstanceFilePath(server.port);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(instanceFile, JSON.stringify({ port: server.port, launchMode: 'daemon' }, null, 2));

        await commands.stop({ quiet: true, suppressQuietOutput: true });

        expect(server.shutdownRequested).toBe(false);
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(instanceFile)).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await server.close();
      }
    });
  });

  it('restart --port restarts a live unmanaged server through the shared explicit-port discovery path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const server = await startMockOpenChamberServer();
      const calls = [];
      const host = '127.0.0.1';
      try {
        const output = await captureStdout(() => commands.restart.call({
          stop: async (options) => {
            calls.push(['stop', options.port, options.host]);
          },
          serve: async (options) => {
            calls.push(['serve', options.port, options.host]);
            return options.port;
          },
        }, { explicitPort: true, port: server.port, host, json: true }));

        const payload = JSON.parse(output);
        expect(calls).toEqual([
          ['stop', server.port, host],
          ['serve', server.port, host],
        ]);
        expect(payload.restartedCount).toBe(1);
        expect(payload.results).toEqual([
          expect.objectContaining({ fromPort: server.port, toPort: server.port, ok: true }),
        ]);
      } finally {
        await server.close();
      }
    });
  });
});
