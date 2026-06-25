import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Spawn occtl and capture stdout/stderr/exit-code. */
async function runOcctl(args, serverPort = null) {
  const { spawn } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const { default: path } = await import('path');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const bin = path.join(__dirname, 'occtl.js');

  const allArgs = serverPort
    ? ['--port', String(serverPort), '--plain', ...args]
    : ['--plain', ...args];

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [bin, ...allArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Tiny HTTP server to mock the OpenChamber API during tests. */
function createMockServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const key = `${req.method} ${req.url.split('?')[0]}`;
        const handler = handlers[key];
        if (handler) {
          const parsed = body ? JSON.parse(body) : undefined;
          const result = handler(req, parsed);
          const payload = JSON.stringify(result);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(payload);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No mock for ${key}` }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('occtl CLI — arg parsing & help', () => {
  it('prints help and exits 0 with --help', async () => {
    const r = await runOcctl(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('occtl');
    expect(r.stdout).toContain('project');
    expect(r.stdout).toContain('session');
    expect(r.stdout).toContain('task');
    expect(r.stdout).toContain('worktree');
    expect(r.stdout).toContain('config');
    expect(r.stdout).toContain('server');
  });

  it('prints version and exits 0 with --version', async () => {
    const r = await runOcctl(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/occtl \d+\.\d+\.\d+/);
  });

  it('exits 0 with no args (shows help)', async () => {
    const r = await runOcctl([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('exits 1 with connection error when server is not running', async () => {
    const r = await runOcctl(['--port', '19999', 'server', 'health']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Cannot connect');
  });

  it('exits 2 for unknown command', async () => {
    const r = await runOcctl(['--port', '19999', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command');
  });

  it('exits 2 for unknown subcommand', async () => {
    const r = await runOcctl(['--port', '19999', 'project', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown project subcommand');
  });
});

describe('occtl CLI — task argument validation', () => {
  it('fails when --name is missing', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--prompt', 'x', '--schedule', 'daily', '--time', '09:00']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--name');
  });

  it('fails when --prompt is missing', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--schedule', 'daily', '--time', '09:00']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--prompt');
  });

  it('fails when --schedule is missing', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--prompt', 'y']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--schedule');
  });

  it('fails for daily schedule without --time', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--prompt', 'y', '--schedule', 'daily']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--time');
  });

  it('fails for weekly schedule without --weekdays', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--prompt', 'y', '--schedule', 'weekly', '--time', '09:00']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--weekdays');
  });

  it('fails for once schedule without --date', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--prompt', 'y', '--schedule', 'once', '--time', '09:00']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--date');
  });

  it('fails for cron schedule without --cron', async () => {
    const r = await runOcctl(['task', 'add', 'proj-1', '--name', 'x', '--prompt', 'y', '--schedule', 'cron']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--cron');
  });
});

describe('occtl CLI — worktree argument validation', () => {
  it('fails list without --directory', async () => {
    const r = await runOcctl(['--port', '19999', 'worktree', 'list']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--directory');
  });

  it('fails remove without --worktree', async () => {
    const r = await runOcctl(['--port', '19999', 'worktree', 'remove', '--directory', '/tmp/x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--worktree');
  });
});

describe('occtl CLI — project commands against mock server', () => {
  let server;
  let port;

  const PROJECTS = [
    { id: 'proj-abc', path: '/home/user/myapp', label: 'My App', color: '#ff0000', addedAt: 1700000000000 },
    { id: 'proj-def', path: '/home/user/other', addedAt: 1700100000000 },
  ];

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      'GET /api/config/settings': () => ({ projects: PROJECTS, activeProjectId: 'proj-abc' }),
      'PUT /api/config/settings': (_req, body) => ({ projects: body.projects || PROJECTS, activeProjectId: body.activeProjectId }),
      'POST /api/opencode/directory': () => ({
        success: true,
        path: '/home/user/newapp',
        settings: { projects: [...PROJECTS, { id: 'proj-new', path: '/home/user/newapp', addedAt: Date.now() }] },
      }),
    }));
  });

  afterEach(() => {
    server.close();
  });

  it('project list shows table rows', async () => {
    const r = await runOcctl(['project', 'list'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('proj-abc');
    expect(r.stdout).toContain('My App');
    expect(r.stdout).toContain('/home/user/myapp');
  });

  it('project list --json returns JSON array', async () => {
    const r = await runOcctl(['--json', 'project', 'list'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('proj-abc');
  });

  it('project info shows detail for existing project', async () => {
    const r = await runOcctl(['project', 'info', 'proj-abc'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('proj-abc');
    expect(r.stdout).toContain('/home/user/myapp');
    expect(r.stdout).toContain('My App');
  });

  it('project info --json returns project object', async () => {
    const r = await runOcctl(['--json', 'project', 'info', 'proj-abc'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.id).toBe('proj-abc');
    expect(data.path).toBe('/home/user/myapp');
  });

  it('project info exits 1 for unknown id', async () => {
    const r = await runOcctl(['project', 'info', 'nonexistent'], port);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("'nonexistent'");
  });

  it('project remove exits successfully', async () => {
    const r = await runOcctl(['project', 'remove', 'proj-abc'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('proj-abc');
  });

  it('project remove exits 1 for unknown id', async () => {
    const r = await runOcctl(['project', 'remove', 'nonexistent'], port);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it('project set-active succeeds', async () => {
    const r = await runOcctl(['project', 'set-active', 'proj-def'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('proj-def');
  });

  it('project add succeeds', async () => {
    const r = await runOcctl(['project', 'add', '/home/user/newapp', '--label', 'New App'], port);
    expect(r.code).toBe(0);
  });

  it('project configure exits 1 without patch options', async () => {
    const r = await runOcctl(['project', 'configure', 'proj-abc'], port);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one option');
  });

  it('project configure updates label', async () => {
    const r = await runOcctl(['project', 'configure', 'proj-abc', '--label', 'Renamed'], port);
    expect(r.code).toBe(0);
  });

  it('aliases: proj, rm work', async () => {
    const r = await runOcctl(['proj', 'rm', 'proj-abc'], port);
    expect(r.code).toBe(0);
  });
});

describe('occtl CLI — task commands against mock server', () => {
  let server;
  let port;

  const PROJECT_ID = 'proj-123';
  const TASKS = [
    {
      id: 'task-1',
      name: 'Daily sync',
      enabled: true,
      prompt: 'Run daily sync',
      schedule: { kind: 'daily', times: ['09:00'] },
      state: { lastStatus: 'success', lastRunAt: 1700000000000 },
    },
    {
      id: 'task-2',
      name: 'Weekly report',
      enabled: false,
      prompt: 'Write weekly report',
      schedule: { kind: 'weekly', weekdays: [1, 5], times: ['10:00'] },
      state: { lastStatus: 'idle' },
    },
  ];

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      [`GET /api/projects/${PROJECT_ID}/scheduled-tasks`]: () => ({ tasks: TASKS }),
      [`PUT /api/projects/${PROJECT_ID}/scheduled-tasks`]: (_req, body) => ({
        task: body.task,
        tasks: TASKS,
        created: !body.task?.id,
      }),
      [`DELETE /api/projects/${PROJECT_ID}/scheduled-tasks/task-1`]: () => ({ tasks: [TASKS[1]] }),
      [`POST /api/projects/${PROJECT_ID}/scheduled-tasks/task-1/run`]: () => ({ ok: true, sessionId: 'sess-abc' }),
      'GET /api/openchamber/scheduled-tasks/status': () => ({
        hasEnabledScheduledTasks: true,
        hasRunningScheduledTasks: false,
        enabledScheduledTasksCount: 1,
        runningScheduledTasksCount: 0,
      }),
      'GET /api/config/settings': () => ({
        projects: [{ id: PROJECT_ID, path: '/home/user/proj', label: 'Test' }],
      }),
    }));
  });

  afterEach(() => { server.close(); });

  it('task list shows table', async () => {
    const r = await runOcctl(['task', 'list', PROJECT_ID], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task-1');
    expect(r.stdout).toContain('Daily sync');
    expect(r.stdout).toContain('daily @ 09:00');
  });

  it('task list --json returns array', async () => {
    const r = await runOcctl(['--json', 'task', 'list', PROJECT_ID], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].id).toBe('task-1');
  });

  it('task list requires project-id', async () => {
    const r = await runOcctl(['task', 'list'], port);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('project-id');
  });

  it('task add creates a daily task', async () => {
    const r = await runOcctl([
      'task', 'add', PROJECT_ID,
      '--name', 'New Task',
      '--prompt', 'Do something',
      '--schedule', 'daily',
      '--time', '08:00',
    ], port);
    expect(r.code).toBe(0);
  });

  it('task add --json returns created task', async () => {
    const r = await runOcctl([
      '--json', 'task', 'add', PROJECT_ID,
      '--name', 'New Task',
      '--prompt', 'Do something',
      '--schedule', 'daily',
      '--time', '08:00',
    ], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.name).toBe('New Task');
  });

  it('task remove deletes a task', async () => {
    const r = await runOcctl(['task', 'remove', PROJECT_ID, 'task-1'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('task-1');
  });

  it('task run executes task and shows session id', async () => {
    const r = await runOcctl(['task', 'run', PROJECT_ID, 'task-1'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('sess-abc');
  });

  it('task enable updates enabled flag', async () => {
    const r = await runOcctl(['task', 'enable', PROJECT_ID, 'task-1'], port);
    expect(r.code).toBe(0);
  });

  it('task disable updates enabled flag', async () => {
    const r = await runOcctl(['task', 'disable', PROJECT_ID, 'task-1'], port);
    expect(r.code).toBe(0);
  });

  it('task status shows global counts', async () => {
    const r = await runOcctl(['task', 'status'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1');
  });

  it('task status --json returns object', async () => {
    const r = await runOcctl(['--json', 'task', 'status'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.enabledScheduledTasksCount).toBe(1);
  });
});

describe('occtl CLI — worktree commands against mock server', () => {
  let server;
  let port;

  const DIR = '/home/user/myrepo';
  const WORKTREES = [
    { path: '/home/user/myrepo-wt1', branch: 'feature/x', label: 'Feature X', worktreeStatus: 'ready' },
    { path: '/home/user/myrepo', branch: 'main', label: '', worktreeStatus: 'ready' },
  ];

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      'GET /api/git/worktrees': () => WORKTREES,
      'POST /api/git/worktrees': () => ({ path: '/home/user/myrepo-new', branch: 'feature/new' }),
      'DELETE /api/git/worktrees': () => ({ success: true }),
      'POST /api/git/worktrees/preview': () => ({ path: '/home/user/myrepo-prev', branch: 'feature/prev', base: 'main' }),
    }));
  });

  afterEach(() => { server.close(); });

  it('worktree list shows table', async () => {
    const r = await runOcctl(['worktree', 'list', '--directory', DIR], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('feature/x');
    expect(r.stdout).toContain('ready');
  });

  it('worktree list --json returns array', async () => {
    const r = await runOcctl(['--json', 'worktree', 'list', '--directory', DIR], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].branch).toBe('feature/x');
  });

  it('worktree create succeeds and reports branch', async () => {
    const r = await runOcctl(['worktree', 'create', '--directory', DIR, '--branch', 'feature/new'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('created');
  });

  it('worktree remove succeeds', async () => {
    const r = await runOcctl(['worktree', 'remove', '--directory', DIR, '--worktree', '/home/user/myrepo-wt1'], port);
    expect(r.code).toBe(0);
  });

  it('worktree preview shows details', async () => {
    const r = await runOcctl(['worktree', 'preview', '--directory', DIR, '--branch', 'feature/prev'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('feature/prev');
  });

  it('wt alias works', async () => {
    const r = await runOcctl(['wt', 'list', '--directory', DIR], port);
    expect(r.code).toBe(0);
  });
});

describe('occtl CLI — config commands against mock server', () => {
  let server;
  let port;

  const SETTINGS = {
    themeId: 'dark-pro',
    themeVariant: 'dark',
    uiFont: 'IBM Plex Sans',
    activeProjectId: 'proj-abc',
    projects: [{ id: 'proj-abc', path: '/home/user/x', label: 'X' }],
  };

  const THEMES = [
    { id: 'dark-pro', name: 'Dark Pro', variant: 'dark' },
    { id: 'light-clean', name: 'Light Clean', variant: 'light' },
  ];

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      'GET /api/config/settings': () => SETTINGS,
      'PUT /api/config/settings': (_req, body) => ({ ...SETTINGS, ...body }),
      'GET /api/config/themes': () => THEMES,
      'POST /api/config/reload': () => ({ ok: true }),
    }));
  });

  afterEach(() => { server.close(); });

  it('config get shows settings', async () => {
    const r = await runOcctl(['config', 'get'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('themeId');
    expect(r.stdout).toContain('dark-pro');
  });

  it('config get <key> shows single value', async () => {
    const r = await runOcctl(['config', 'get', 'themeId'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dark-pro');
  });

  it('config get --json returns full settings', async () => {
    const r = await runOcctl(['--json', 'config', 'get'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.themeId).toBe('dark-pro');
  });

  it('config get theme (alias) resolves key', async () => {
    const r = await runOcctl(['config', 'get', 'theme'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('themeId');
    expect(r.stdout).toContain('dark-pro');
  });

  it('config set updates a value', async () => {
    const r = await runOcctl(['config', 'set', 'themeId', 'light-clean'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('light-clean');
  });

  it('config themes lists themes in table', async () => {
    const r = await runOcctl(['config', 'themes'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dark-pro');
    expect(r.stdout).toContain('light-clean');
  });

  it('config themes --json returns array', async () => {
    const r = await runOcctl(['--json', 'config', 'themes'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data).toHaveLength(2);
  });

  it('config reload succeeds', async () => {
    const r = await runOcctl(['config', 'reload'], port);
    expect(r.code).toBe(0);
  });
});

describe('occtl CLI — server commands against mock server', () => {
  let server;
  let port;

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      'GET /health': () => ({ ok: true }),
      'GET /api/system/info': () => ({
        version: '1.11.5',
        platform: 'linux',
        nodeVersion: '20.0.0',
        pid: 12345,
      }),
    }));
  });

  afterEach(() => { server.close(); });

  it('server health reports healthy', async () => {
    const r = await runOcctl(['server', 'health'], port);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('healthy');
  });

  it('server health --json returns object', async () => {
    const r = await runOcctl(['--json', 'server', 'health'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.healthy).toBe(true);
  });

  it('server info shows system details', async () => {
    const r = await runOcctl(['server', 'info'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('version');
    expect(r.stdout).toContain('1.11.5');
  });

  it('server status shows port and host', async () => {
    const r = await runOcctl(['server', 'status'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(String(port));
  });

  it('server status --json returns object', async () => {
    const r = await runOcctl(['--json', 'server', 'status'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.healthy).toBe(true);
    expect(data.port).toBe(port);
  });

  it('srv alias works', async () => {
    const r = await runOcctl(['srv', 'health'], port);
    expect(r.code).toBe(0);
  });
});

describe('occtl CLI — session commands against mock server', () => {
  let server;
  let port;

  const SESSIONS = [
    { id: 'sess-aabbccdd', projectId: 'proj-1', status: 'idle', updatedAt: 1700000000000 },
    { id: 'sess-11223344', projectId: 'proj-2', status: 'running', updatedAt: 1700100000000 },
  ];

  beforeEach(async () => {
    ({ server, port } = await createMockServer({
      'GET /api/sessions/snapshot': () => SESSIONS,
      'GET /api/sessions/status': () => ({ activeCount: 1, totalCount: 2 }),
      'GET /api/sessions/attention': () => [],
      'GET /api/sessions/sess-aabbccdd/status': () => ({ id: 'sess-aabbccdd', status: 'idle', projectId: 'proj-1' }),
      'GET /api/sessions/sess-aabbccdd/attention': () => ({ needsAttention: false }),
    }));
  });

  afterEach(() => { server.close(); });

  it('session list shows table', async () => {
    const r = await runOcctl(['session', 'list'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sess-aabbccdd'.slice(0, 12));
    expect(r.stdout).toContain('idle');
  });

  it('session list --json returns array', async () => {
    const r = await runOcctl(['--json', 'session', 'list'], port);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data).toHaveLength(2);
  });

  it('session status shows counts', async () => {
    const r = await runOcctl(['session', 'status'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active sessions');
  });

  it('session info shows session detail', async () => {
    const r = await runOcctl(['session', 'info', 'sess-aabbccdd'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sess-aabbccdd');
    expect(r.stdout).toContain('idle');
  });

  it('session attention with id shows result', async () => {
    const r = await runOcctl(['session', 'attention', 'sess-aabbccdd'], port);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no');
  });

  it('sess alias works', async () => {
    const r = await runOcctl(['sess', 'list'], port);
    expect(r.code).toBe(0);
  });
});
