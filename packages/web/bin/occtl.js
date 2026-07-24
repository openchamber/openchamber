#!/usr/bin/env node
/**
 * occtl - OpenChamber Control CLI
 *
 * Programmatic interface to a running OpenChamber server.
 *
 * Usage: occtl [--port <port>] [--host <host>] [--json] [--quiet] COMMAND [ARGS...]
 *
 * Commands:
 *   project   list | add | remove | info | configure | set-active
 *   session   list | info | status | attention
 *   task      list | add | remove | run | enable | disable | status
 *   worktree  list | create | remove | preview
 *   config    get | set | themes | reload
 *   server    status | info | health
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);
const VERSION = PACKAGE_JSON.version;

// ─── ANSI / terminal helpers ──────────────────────────────────────────────────

const NO_COLOR =
  process.env.NO_COLOR === '1' ||
  process.argv.includes('--plain') ||
  !process.stdout.isTTY;

const C = NO_COLOR
  ? { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', blue: '', cyan: '', magenta: '' }
  : {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m',
      magenta: '\x1b[35m',
    };

const bold = (s) => `${C.bold}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;
const red = (s) => `${C.red}${s}${C.reset}`;
const green = (s) => `${C.green}${s}${C.reset}`;
const yellow = (s) => `${C.yellow}${s}${C.reset}`;
const cyan = (s) => `${C.cyan}${s}${C.reset}`;

// ─── Output helpers ───────────────────────────────────────────────────────────

let jsonMode = false;
let quietMode = false;

function printJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function info(msg) {
  if (!quietMode && !jsonMode) process.stderr.write(`  ${msg}\n`);
}

function success(msg) {
  if (!quietMode && !jsonMode) process.stderr.write(`${green('✓')} ${msg}\n`);
}

function warn(msg) {
  if (!jsonMode) process.stderr.write(`${yellow('!')} ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`${red('✗')} ${msg}\n`);
}

function fatal(msg, code = 1) {
  error(msg);
  process.exit(code);
}

// ─── Table renderer ───────────────────────────────────────────────────────────

function renderTable(rows, opts = {}) {
  if (rows.length === 0) return '';
  const keys = opts.columns || Object.keys(rows[0]);
  const headers = opts.headers || keys.map((k) => k.toUpperCase());

  const widths = keys.map((k, i) => {
    const headerLen = headers[i].length;
    const maxVal = rows.reduce((m, r) => Math.max(m, String(r[k] ?? '').length), 0);
    return Math.max(headerLen, maxVal);
  });

  const sep = '  ';
  const header = headers.map((h, i) => bold(h.padEnd(widths[i]))).join(sep);
  const divider = dim(widths.map((w) => '-'.repeat(w)).join(sep));
  const lines = rows.map((row) =>
    keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i])).join(sep),
  );

  return [header, divider, ...lines].join('\n');
}

// ─── Arg parser ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    port: 3000,
    host: '127.0.0.1',
    json: false,
    quiet: false,
    help: false,
    version: false,
    plain: false,
    _args: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++i]) || 3000;
    } else if (arg.startsWith('--port=')) {
      opts.port = Number(arg.slice(7)) || 3000;
    } else if (arg === '--host') {
      opts.host = argv[++i] || '127.0.0.1';
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice(7);
    } else if (arg === '--json' || arg === '-j') {
      opts.json = true;
    } else if (arg === '--quiet' || arg === '-q') {
      opts.quiet = true;
    } else if (arg === '--plain') {
      opts.plain = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--version' || arg === '-v') {
      opts.version = true;
    } else if (!arg.startsWith('-')) {
      opts._args.push(arg);
    } else {
      // pass-through unknown flags as named properties
      const key = arg.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
    i++;
  }

  return opts;
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

function buildBaseUrl(host, port) {
  const h = host || '127.0.0.1';
  return `http://${h}:${port}`;
}

async function apiRequest(baseUrl, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${baseUrl}${urlPath}`;
    const url = new URL(fullUrl);
    const isHttps = url.protocol === 'https:';
    const agent = isHttps ? https : http;

    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { Accept: 'application/json' };
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = agent.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, body: parsed });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Cannot connect to OpenChamber on ${baseUrl}. Is the server running?`));
      } else {
        reject(err);
      }
    });

    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function makeApi(host, port) {
  const base = buildBaseUrl(host, port);
  return {
    get: (p) => apiRequest(base, 'GET', p),
    post: (p, b) => apiRequest(base, 'POST', p, b),
    put: (p, b) => apiRequest(base, 'PUT', p, b),
    patch: (p, b) => apiRequest(base, 'PATCH', p, b),
    delete: (p, b) => apiRequest(base, 'DELETE', p, b),
  };
}

function assertOk(res, context) {
  if (res.status >= 400) {
    const msg = (typeof res.body === 'object' && res.body?.error) ? res.body.error : String(res.body);
    fatal(`${context}: ${msg} (HTTP ${res.status})`);
  }
  return res.body;
}

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP = `${bold('occtl')} ${dim(`v${VERSION}`)} — OpenChamber control CLI

${bold('Usage:')}
  occtl [OPTIONS] COMMAND [SUBCOMMAND] [ARGS]

${bold('Global Options:')}
  --port, -p <port>   Server port (default: 3000, env: OPENCHAMBER_PORT)
  --host <host>       Server host (default: 127.0.0.1)
  --json, -j          JSON output (machine-readable)
  --quiet, -q         Suppress informational output
  --plain             Disable colors
  --help, -h          Show help
  --version, -v       Show version

${bold('Commands:')}

  ${bold('project')}  Manage projects
    list                          List all projects
    add <path> [OPTIONS]          Add a project
      --label <label>             Project label
      --color <hex>               Project color (#rrggbb)
    remove <id>                   Remove a project
    info <id>                     Show project details
    configure <id> [OPTIONS]      Update project label/color
    set-active <id>               Set as active project

  ${bold('session')}  Inspect sessions
    list [--project <id>]         List all sessions (status snapshot)
    info <id>                     Get session details
    status [<id>]                 Get session status
    attention [<id>]              Check sessions needing attention

  ${bold('task')}  Manage scheduled tasks
    list <project-id>             List tasks for a project
    add <project-id> [OPTIONS]    Add or update a scheduled task
      --name <name>               Task name (required)
      --prompt <text>             Task prompt (required)
      --schedule <kind>           Schedule kind: daily|weekly|once|cron
      --time <HH:MM>              Run time(s) (comma-separated for multiple)
      --weekdays <0-6,...>        Weekdays for weekly schedule (0=Sun)
      --date <YYYY-MM-DD>         Date for once schedule
      --cron <expr>               Cron expression for cron schedule
      --timezone <tz>             IANA timezone (default: local)
      --id <task-id>              Task ID for update (omit to create)
      --disable                   Create task as disabled
    remove <project-id> <task-id> Delete a scheduled task
    run <project-id> <task-id>    Run a task immediately
    enable <project-id> <task-id> Enable a scheduled task
    disable <project-id> <task-id> Disable a scheduled task
    status                        Show global scheduled-task status

  ${bold('worktree')}  Manage git worktrees
    list --directory <dir>        List worktrees for a directory
    create --directory <dir> [OPTIONS]  Create a worktree
      --branch <branch>           New branch name
      --base <base>               Base branch (default: current HEAD)
      --worktree-root <path>      Custom worktree root path
    remove --directory <dir> [OPTIONS]  Remove a worktree
      --worktree <path>           Worktree directory to remove
      --delete-branch             Also delete the local branch
    preview --directory <dir> [OPTIONS]  Preview worktree creation
      --branch <branch>           Branch name to preview
      --base <base>               Base branch

  ${bold('config')}  Manage OpenChamber configuration
    get [key]                     Show all settings or a specific key
    set <key> <value>             Update a setting
    themes                        List available themes
    reload                        Reload config from disk

  ${bold('server')}  Server information
    status                        Show running instance status
    info                          Show detailed server info
    health                        Health check

${bold('Examples:')}
  # Add a project and list tasks
  occtl project add /home/user/myapp --label "My App"
  occtl task list <project-id>

  # Create a daily scheduled task at 09:00
  occtl task add <project-id> --name "Morning standup" \\
    --prompt "Summarize yesterday's work" \\
    --schedule daily --time 09:00

  # Run a task immediately
  occtl task run <project-id> <task-id>

  # List worktrees for a git repo
  occtl worktree list --directory /home/user/myapp

  # Create a worktree on a new branch
  occtl worktree create --directory /home/user/myapp --branch feature/new-ui

  # Show current config in JSON
  occtl --json config get

  # Check server health
  occtl server health
`;

// ─── Command implementations ──────────────────────────────────────────────────

// ── project ──

async function cmdProjectList(api, _opts, _args) {
  const res = await api.get('/api/config/settings');
  const settings = assertOk(res, 'project list');
  const projects = settings.projects || [];

  if (jsonMode) {
    printJson(projects);
    return;
  }

  if (projects.length === 0) {
    info('No projects configured.');
    return;
  }

  const rows = projects.map((p) => ({
    id: p.id,
    label: p.label || dim('—'),
    path: p.path,
    color: p.color || dim('—'),
  }));
  console.log(renderTable(rows, { headers: ['ID', 'LABEL', 'PATH', 'COLOR'] }));
  info(`\n${projects.length} project(s)`);
}

async function cmdProjectAdd(api, opts, args) {
  const targetPath = args[0];
  if (!targetPath) fatal('Usage: occtl project add <path> [--label <l>] [--color <c>]');

  const resolved = path.resolve(targetPath);

  // Use the directory endpoint which handles project registration
  const res = await api.post('/api/opencode/directory', { path: resolved });
  const data = assertOk(res, 'project add');

  const projects = data.settings?.projects || [];
  const added = projects.find((p) => p.path === data.path || p.path === resolved);

  // Apply label/color if provided
  if (added && (opts.label || opts.color)) {
    const updated = projects.map((p) =>
      p.id === added.id
        ? { ...p, ...(opts.label ? { label: opts.label } : {}), ...(opts.color ? { color: opts.color } : {}) }
        : p,
    );
    const saveRes = await api.put('/api/config/settings', { projects: updated });
    assertOk(saveRes, 'project add (configure)');
    if (jsonMode) {
      printJson({ id: added.id, path: resolved, label: opts.label, color: opts.color });
      return;
    }
    success(`Project added and configured: ${bold(added.id)}`);
  } else {
    if (jsonMode) {
      printJson(added || { path: resolved });
      return;
    }
    success(`Project added: ${bold(added?.id || resolved)}`);
  }
  info(`Path: ${resolved}`);
}

async function cmdProjectRemove(api, _opts, args) {
  const id = args[0];
  if (!id) fatal('Usage: occtl project remove <id>');

  const res = await api.get('/api/config/settings');
  const settings = assertOk(res, 'project remove (get)');
  const projects = (settings.projects || []).filter((p) => p.id !== id);

  if (projects.length === (settings.projects || []).length) {
    fatal(`Project '${id}' not found.`);
  }

  const saveRes = await api.put('/api/config/settings', { projects });
  assertOk(saveRes, 'project remove (save)');

  if (jsonMode) { printJson({ removed: id }); return; }
  success(`Project removed: ${bold(id)}`);
}

async function cmdProjectInfo(api, _opts, args) {
  const id = args[0];
  if (!id) fatal('Usage: occtl project info <id>');

  const res = await api.get('/api/config/settings');
  const settings = assertOk(res, 'project info');
  const project = (settings.projects || []).find((p) => p.id === id);
  if (!project) fatal(`Project '${id}' not found.`);

  if (jsonMode) { printJson(project); return; }

  console.log(`${bold('ID:')}          ${project.id}`);
  console.log(`${bold('Path:')}        ${project.path}`);
  console.log(`${bold('Label:')}       ${project.label || dim('—')}`);
  console.log(`${bold('Color:')}       ${project.color || dim('—')}`);
  console.log(`${bold('Added:')}       ${project.addedAt ? new Date(project.addedAt).toLocaleString() : dim('—')}`);
  console.log(`${bold('Last opened:')} ${project.lastOpenedAt ? new Date(project.lastOpenedAt).toLocaleString() : dim('—')}`);
}

async function cmdProjectConfigure(api, opts, args) {
  const id = args[0];
  if (!id) fatal('Usage: occtl project configure <id> [--label <l>] [--color <c>]');

  const res = await api.get('/api/config/settings');
  const settings = assertOk(res, 'project configure (get)');
  const projects = settings.projects || [];
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) fatal(`Project '${id}' not found.`);

  const patch = {};
  if (opts.label !== undefined) patch.label = opts.label;
  if (opts.color !== undefined) patch.color = opts.color;

  if (Object.keys(patch).length === 0) {
    fatal('Provide at least one option to update: --label, --color');
  }

  projects[idx] = { ...projects[idx], ...patch };
  const saveRes = await api.put('/api/config/settings', { projects });
  assertOk(saveRes, 'project configure (save)');

  if (jsonMode) { printJson(projects[idx]); return; }
  success(`Project ${bold(id)} updated.`);
}

async function cmdProjectSetActive(api, _opts, args) {
  const id = args[0];
  if (!id) fatal('Usage: occtl project set-active <id>');

  const res = await api.put('/api/config/settings', { activeProjectId: id });
  assertOk(res, 'project set-active');

  if (jsonMode) { printJson({ activeProjectId: id }); return; }
  success(`Active project set to: ${bold(id)}`);
}

// ── session ──

async function cmdSessionList(api, opts, _args) {
  const res = await api.get('/api/sessions/snapshot');
  const data = assertOk(res, 'session list');

  let sessions = Array.isArray(data) ? data : (data.sessions || []);
  if (opts.project) {
    sessions = sessions.filter((s) => s.projectId === opts.project);
  }

  if (jsonMode) { printJson(sessions); return; }
  if (sessions.length === 0) { info('No sessions found.'); return; }

  const rows = sessions.map((s) => ({
    id: String(s.id || '').slice(0, 12),
    project: s.projectId || dim('—'),
    status: s.status || dim('—'),
    updated: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : dim('—'),
  }));
  console.log(renderTable(rows, { headers: ['ID', 'PROJECT', 'STATUS', 'UPDATED'] }));
  info(`\n${sessions.length} session(s)`);
}

async function cmdSessionInfo(api, _opts, args) {
  const id = args[0];
  if (!id) fatal('Usage: occtl session info <id>');

  const res = await api.get(`/api/sessions/${encodeURIComponent(id)}/status`);
  const data = assertOk(res, 'session info');

  if (jsonMode) { printJson(data); return; }

  console.log(`${bold('ID:')}      ${id}`);
  console.log(`${bold('Status:')} ${data.status || dim('—')}`);
  if (data.projectId) console.log(`${bold('Project:')} ${data.projectId}`);
}

async function cmdSessionStatus(api, _opts, args) {
  const id = args[0];
  if (id) {
    const res = await api.get(`/api/sessions/${encodeURIComponent(id)}/status`);
    const data = assertOk(res, 'session status');
    if (jsonMode) { printJson(data); return; }
    console.log(`Status: ${data.status || dim('—')}`);
  } else {
    const res = await api.get('/api/sessions/status');
    const data = assertOk(res, 'session status');
    if (jsonMode) { printJson(data); return; }
    console.log(`Active sessions: ${data.activeCount ?? dim('—')}`);
    console.log(`Total sessions:  ${data.totalCount ?? dim('—')}`);
  }
}

async function cmdSessionAttention(api, _opts, args) {
  const id = args[0];
  if (id) {
    const res = await api.get(`/api/sessions/${encodeURIComponent(id)}/attention`);
    const data = assertOk(res, 'session attention');
    if (jsonMode) { printJson(data); return; }
    const needs = data.needsAttention || data.attention;
    console.log(`Needs attention: ${needs ? yellow('yes') : green('no')}`);
  } else {
    const res = await api.get('/api/sessions/attention');
    const data = assertOk(res, 'session attention');
    if (jsonMode) { printJson(data); return; }
    const sessions = Array.isArray(data) ? data : (data.sessions || []);
    if (sessions.length === 0) { info('No sessions need attention.'); return; }
    const rows = sessions.map((s) => ({
      id: String(s.id || '').slice(0, 12),
      project: s.projectId || dim('—'),
      reason: s.reason || dim('—'),
    }));
    console.log(renderTable(rows, { headers: ['ID', 'PROJECT', 'REASON'] }));
  }
}

// ── task ──

async function cmdTaskList(api, _opts, args) {
  const projectId = args[0];
  if (!projectId) fatal('Usage: occtl task list <project-id>');

  const res = await api.get(`/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`);
  const data = assertOk(res, 'task list');
  const tasks = data.tasks || [];

  if (jsonMode) { printJson(tasks); return; }
  if (tasks.length === 0) { info('No scheduled tasks for this project.'); return; }

  const rows = tasks.map((t) => ({
    id: t.id,
    name: t.name || dim('—'),
    enabled: t.enabled ? green('yes') : red('no'),
    schedule: formatSchedule(t.schedule),
    lastStatus: formatTaskStatus(t.state?.lastStatus),
    lastRun: t.state?.lastRunAt ? new Date(t.state.lastRunAt).toLocaleString() : dim('—'),
  }));
  console.log(
    renderTable(rows, {
      headers: ['ID', 'NAME', 'ENABLED', 'SCHEDULE', 'LAST STATUS', 'LAST RUN'],
    }),
  );
  info(`\n${tasks.length} task(s)`);
}

function formatSchedule(schedule) {
  if (!schedule) return dim('—');
  const { kind } = schedule;
  if (kind === 'daily') {
    const times = schedule.times || (schedule.time ? [schedule.time] : []);
    return `daily @ ${times.join(', ')}`;
  }
  if (kind === 'weekly') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekdays = (schedule.weekdays || []).map((d) => days[d] || d).join(',');
    const times = schedule.times || (schedule.time ? [schedule.time] : []);
    return `weekly ${weekdays} @ ${times.join(', ')}`;
  }
  if (kind === 'once') return `once @ ${schedule.date} ${schedule.time || ''}`.trim();
  if (kind === 'cron') return `cron: ${schedule.expression}`;
  return kind;
}

function formatTaskStatus(status) {
  if (!status || status === 'idle') return dim('idle');
  if (status === 'running') return cyan('running');
  if (status === 'success') return green('success');
  if (status === 'error') return red('error');
  return status;
}

async function cmdTaskAdd(api, opts, args) {
  const projectId = args[0];
  if (!projectId) fatal('Usage: occtl task add <project-id> [OPTIONS]');

  if (!opts.name) fatal('--name <name> is required');
  if (!opts.prompt) fatal('--prompt <text> is required');
  if (!opts.schedule) fatal('--schedule <daily|weekly|once|cron> is required');

  const schedule = buildSchedule(opts);

  const task = {
    ...(opts.id ? { id: opts.id } : {}),
    name: opts.name,
    prompt: opts.prompt,
    enabled: opts.disable !== true,
    schedule,
  };

  const res = await api.put(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`,
    { task },
  );
  const data = assertOk(res, 'task add');

  if (jsonMode) { printJson(data.task); return; }
  success(`Task ${data.created ? 'created' : 'updated'}: ${bold(data.task?.id || '?')}`);
}

function buildSchedule(opts) {
  const kind = opts.schedule;
  const timezone = opts.timezone || undefined;

  if (kind === 'daily') {
    const rawTimes = opts.time;
    if (!rawTimes) fatal('--time <HH:MM> is required for daily schedule');
    const times = String(rawTimes).split(',').map((t) => t.trim());
    return { kind: 'daily', times, ...(timezone ? { timezone } : {}) };
  }

  if (kind === 'weekly') {
    const rawTimes = opts.time;
    if (!rawTimes) fatal('--time <HH:MM> is required for weekly schedule');
    const rawWeekdays = opts.weekdays;
    if (!rawWeekdays) fatal('--weekdays <0-6,...> is required for weekly schedule (0=Sun)');
    const times = String(rawTimes).split(',').map((t) => t.trim());
    const weekdays = String(rawWeekdays).split(',').map((d) => Number(d.trim()));
    return { kind: 'weekly', times, weekdays, ...(timezone ? { timezone } : {}) };
  }

  if (kind === 'once') {
    if (!opts.date) fatal('--date <YYYY-MM-DD> is required for once schedule');
    if (!opts.time) fatal('--time <HH:MM> is required for once schedule');
    return { kind: 'once', date: opts.date, time: opts.time, ...(timezone ? { timezone } : {}) };
  }

  if (kind === 'cron') {
    if (!opts.cron) fatal('--cron <expression> is required for cron schedule');
    return {
      kind: 'cron',
      expression: opts.cron,
      ...(timezone ? { timezone } : {}),
    };
  }

  fatal(`Unknown schedule kind: ${kind}. Use daily, weekly, once, or cron.`);
}

async function cmdTaskRemove(api, _opts, args) {
  const [projectId, taskId] = args;
  if (!projectId || !taskId) fatal('Usage: occtl task remove <project-id> <task-id>');

  const res = await api.delete(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
  );
  assertOk(res, 'task remove');

  if (jsonMode) { printJson({ removed: taskId }); return; }
  success(`Task removed: ${bold(taskId)}`);
}

async function cmdTaskRun(api, _opts, args) {
  const [projectId, taskId] = args;
  if (!projectId || !taskId) fatal('Usage: occtl task run <project-id> <task-id>');

  info(`Running task ${taskId}…`);
  const res = await api.post(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks/${encodeURIComponent(taskId)}/run`,
  );
  const data = assertOk(res, 'task run');

  if (jsonMode) { printJson(data); return; }
  success(`Task started. Session: ${bold(data.sessionId || '?')}`);
}

async function cmdTaskSetEnabled(api, _opts, args, enabled) {
  const [projectId, taskId] = args;
  const verb = enabled ? 'enable' : 'disable';
  if (!projectId || !taskId) fatal(`Usage: occtl task ${verb} <project-id> <task-id>`);

  const listRes = await api.get(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`,
  );
  const listData = assertOk(listRes, `task ${verb} (get)`);
  const task = (listData.tasks || []).find((t) => t.id === taskId);
  if (!task) fatal(`Task '${taskId}' not found in project '${projectId}'.`);

  const res = await api.put(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`,
    { task: { ...task, enabled } },
  );
  assertOk(res, `task ${verb}`);

  if (jsonMode) { printJson({ id: taskId, enabled }); return; }
  success(`Task ${enabled ? green('enabled') : red('disabled')}: ${bold(taskId)}`);
}

async function cmdTaskStatus(api, _opts, _args) {
  const res = await api.get('/api/openchamber/scheduled-tasks/status');
  const data = assertOk(res, 'task status');

  if (jsonMode) { printJson(data); return; }
  console.log(`Enabled tasks:  ${data.enabledScheduledTasksCount ?? 0}`);
  console.log(`Running tasks:  ${data.runningScheduledTasksCount ?? 0}`);
  console.log(`Has enabled:    ${data.hasEnabledScheduledTasks ? green('yes') : 'no'}`);
  console.log(`Has running:    ${data.hasRunningScheduledTasks ? cyan('yes') : 'no'}`);
}

// ── worktree ──

async function cmdWorktreeList(api, opts, _args) {
  const dir = opts.directory || opts.dir || opts.d;
  if (!dir) fatal('--directory <path> is required');

  const dirEnc = encodeURIComponent(dir);
  const res = await api.get(`/api/git/worktrees?directory=${dirEnc}`);
  const worktrees = assertOk(res, 'worktree list');

  if (jsonMode) { printJson(worktrees); return; }
  if (!Array.isArray(worktrees) || worktrees.length === 0) { info('No worktrees found.'); return; }

  const rows = worktrees.map((w) => ({
    path: w.path || w.worktreePath || dim('—'),
    branch: w.branch || dim('—'),
    label: w.label || dim('—'),
    status: w.worktreeStatus || w.status || dim('—'),
  }));
  console.log(renderTable(rows, { headers: ['PATH', 'BRANCH', 'LABEL', 'STATUS'] }));
  info(`\n${worktrees.length} worktree(s)`);
}

async function cmdWorktreeCreate(api, opts, _args) {
  const dir = opts.directory || opts.dir || opts.d;
  if (!dir) fatal('--directory <path> is required');

  const body = {};
  if (opts.branch) body.branch = opts.branch;
  if (opts.base) body.base = opts.base;
  if (opts.worktreeRoot || opts['worktree-root']) {
    body.worktreeRoot = opts.worktreeRoot || opts['worktree-root'];
  }

  const dirEnc = encodeURIComponent(dir);
  const res = await api.post(`/api/git/worktrees?directory=${dirEnc}`, body);
  const data = assertOk(res, 'worktree create');

  if (jsonMode) { printJson(data); return; }
  success(`Worktree created`);
  if (data.path) info(`Path:   ${data.path}`);
  if (data.branch) info(`Branch: ${data.branch}`);
}

async function cmdWorktreePreview(api, opts, _args) {
  const dir = opts.directory || opts.dir || opts.d;
  if (!dir) fatal('--directory <path> is required');

  const body = {};
  if (opts.branch) body.branch = opts.branch;
  if (opts.base) body.base = opts.base;

  const dirEnc = encodeURIComponent(dir);
  const res = await api.post(`/api/git/worktrees/preview?directory=${dirEnc}`, body);
  const data = assertOk(res, 'worktree preview');

  if (jsonMode) { printJson(data); return; }
  console.log(`${bold('Branch:')}       ${data.branch || dim('—')}`);
  console.log(`${bold('Base:')}         ${data.base || dim('—')}`);
  console.log(`${bold('Target path:')} ${data.path || dim('—')}`);
}

async function cmdWorktreeRemove(api, opts, _args) {
  const dir = opts.directory || opts.dir || opts.d;
  const worktreePath = opts.worktree;
  if (!dir) fatal('--directory <path> is required');
  if (!worktreePath) fatal('--worktree <path> is required');

  const body = {
    directory: worktreePath,
    deleteLocalBranch: opts.deleteBranch === true || opts['delete-branch'] === true,
  };

  const dirEnc = encodeURIComponent(dir);
  const res = await api.delete(`/api/git/worktrees?directory=${dirEnc}`, body);
  assertOk(res, 'worktree remove');

  if (jsonMode) { printJson({ removed: worktreePath }); return; }
  success(`Worktree removed: ${bold(worktreePath)}`);
}

// ── config ──

const CONFIG_KEY_MAP = {
  // shorthand → actual settings field
  theme: 'themeId',
  'theme-variant': 'themeVariant',
  'ui-font': 'uiFont',
  'mono-font': 'monoFont',
  'last-directory': 'lastDirectory',
  'home-directory': 'homeDirectory',
  'active-project': 'activeProjectId',
};

async function cmdConfigGet(api, _opts, args) {
  const res = await api.get('/api/config/settings');
  const settings = assertOk(res, 'config get');

  const key = args[0];
  if (key) {
    const resolvedKey = CONFIG_KEY_MAP[key] || key;
    const value = settings[resolvedKey];
    if (jsonMode) { printJson({ [resolvedKey]: value }); return; }
    console.log(`${bold(resolvedKey)}: ${value !== undefined ? String(value) : dim('not set')}`);
  } else {
    if (jsonMode) { printJson(settings); return; }
    // Print human-readable key listing (omit large/complex values)
    const skip = new Set(['projects', 'managedRemoteTunnelPresets', 'managedRemoteTunnelPresetTokens']);
    for (const [k, v] of Object.entries(settings)) {
      if (skip.has(k)) continue;
      if (typeof v === 'object') continue;
      console.log(`${bold(k)}: ${v !== undefined && v !== null ? String(v) : dim('—')}`);
    }
    info(`\nUse --json flag for full settings including projects array.`);
  }
}

async function cmdConfigSet(api, _opts, args) {
  const [key, ...rest] = args;
  if (!key) fatal('Usage: occtl config set <key> <value>');
  const value = rest.join(' ');
  if (!value) fatal('A value is required');

  const resolvedKey = CONFIG_KEY_MAP[key] || key;

  // Coerce booleans and numbers
  let coerced = value;
  if (value === 'true') coerced = true;
  else if (value === 'false') coerced = false;
  else if (!isNaN(Number(value)) && value.trim() !== '') coerced = Number(value);

  const res = await api.put('/api/config/settings', { [resolvedKey]: coerced });
  assertOk(res, 'config set');

  if (jsonMode) { printJson({ [resolvedKey]: coerced }); return; }
  success(`${bold(resolvedKey)} = ${coerced}`);
}

async function cmdConfigThemes(api, _opts, _args) {
  const res = await api.get('/api/config/themes');
  const data = assertOk(res, 'config themes');
  const themes = Array.isArray(data) ? data : (data.themes || []);

  if (jsonMode) { printJson(themes); return; }
  if (themes.length === 0) { info('No themes available.'); return; }

  const rows = themes.map((t) => ({
    id: typeof t === 'string' ? t : (t.id || t.name || dim('?')),
    name: typeof t === 'string' ? t : (t.name || t.id || dim('?')),
    variant: typeof t === 'object' ? (t.variant || 'both') : 'both',
  }));
  console.log(renderTable(rows, { headers: ['ID', 'NAME', 'VARIANT'] }));
}

async function cmdConfigReload(api, _opts, _args) {
  const res = await api.post('/api/config/reload');
  assertOk(res, 'config reload');
  if (jsonMode) { printJson({ ok: true }); return; }
  success('Config reloaded.');
}

// ── server ──

async function cmdServerHealth(api, _opts, _args) {
  const res = await api.get('/health');
  if (res.status === 200) {
    if (jsonMode) { printJson({ healthy: true, status: res.status }); return; }
    success('Server is healthy.');
  } else {
    if (jsonMode) { printJson({ healthy: false, status: res.status }); return; }
    error(`Server returned HTTP ${res.status}.`);
    process.exit(1);
  }
}

async function cmdServerInfo(api, _opts, _args) {
  const res = await api.get('/api/system/info');
  const data = assertOk(res, 'server info');

  if (jsonMode) { printJson(data); return; }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'object') continue;
    console.log(`${bold(k)}: ${v}`);
  }
}

async function cmdServerStatus(api, opts, _args) {
  // Try to read a local instance file for port-based status
  const dataDir = process.env.OPENCHAMBER_DATA_DIR ||
    path.join(os.homedir(), '.config', 'openchamber');
  const instanceFile = path.join(dataDir, 'run', `openchamber-${opts.port}.json`);

  let instanceData = null;
  try {
    const raw = fs.readFileSync(instanceFile, 'utf8');
    instanceData = JSON.parse(raw);
  } catch {
    // instance file not found — that's ok
  }

  // Also check health
  let healthy = false;
  try {
    const res = await api.get('/health');
    healthy = res.status === 200;
  } catch {
    // not reachable
  }

  if (jsonMode) {
    printJson({
      port: opts.port,
      host: opts.host,
      healthy,
      instance: instanceData,
    });
    return;
  }

  console.log(`${bold('Port:')}    ${opts.port}`);
  console.log(`${bold('Host:')}    ${opts.host}`);
  console.log(`${bold('Healthy:')} ${healthy ? green('yes') : red('no')}`);
  if (instanceData) {
    if (instanceData.pid) console.log(`${bold('PID:')}     ${instanceData.pid}`);
    if (instanceData.startedAt) {
      console.log(`${bold('Started:')} ${new Date(instanceData.startedAt).toLocaleString()}`);
    }
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const [command, subcommand, ...rest] = opts._args;

  // Apply global output flags
  jsonMode = opts.json;
  quietMode = opts.quiet;

  // Resolve port from env if not explicitly set
  if (!process.argv.includes('--port') && !process.argv.includes('-p')) {
    const envPort = Number(process.env.OPENCHAMBER_PORT);
    if (envPort > 0) opts.port = envPort;
  }

  if (opts.version) {
    console.log(`occtl ${VERSION}`);
    process.exit(0);
  }

  if (opts.help || !command) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const api = makeApi(opts.host, opts.port);

  // Extra positional args after subcommand
  const subArgs = rest;

  try {
    switch (command) {
      // ── project ──────────────────────────────────────────────────────────
      case 'project':
      case 'proj': {
        switch (subcommand) {
          case 'list':    await cmdProjectList(api, opts, subArgs); break;
          case 'add':     await cmdProjectAdd(api, opts, subArgs); break;
          case 'remove':
          case 'rm':      await cmdProjectRemove(api, opts, subArgs); break;
          case 'info':    await cmdProjectInfo(api, opts, subArgs); break;
          case 'configure':
          case 'config':  await cmdProjectConfigure(api, opts, subArgs); break;
          case 'set-active':
          case 'activate': await cmdProjectSetActive(api, opts, subArgs); break;
          default:
            error(`Unknown project subcommand: ${subcommand || '(none)'}`);
            error('Use: list | add | remove | info | configure | set-active');
            process.exit(2);
        }
        break;
      }

      // ── session ──────────────────────────────────────────────────────────
      case 'session':
      case 'sess': {
        switch (subcommand) {
          case 'list':       await cmdSessionList(api, opts, subArgs); break;
          case 'info':       await cmdSessionInfo(api, opts, subArgs); break;
          case 'status':     await cmdSessionStatus(api, opts, subArgs); break;
          case 'attention':  await cmdSessionAttention(api, opts, subArgs); break;
          default:
            error(`Unknown session subcommand: ${subcommand || '(none)'}`);
            error('Use: list | info | status | attention');
            process.exit(2);
        }
        break;
      }

      // ── task ─────────────────────────────────────────────────────────────
      case 'task':
      case 'tasks': {
        switch (subcommand) {
          case 'list':    await cmdTaskList(api, opts, subArgs); break;
          case 'add':
          case 'create':  await cmdTaskAdd(api, opts, subArgs); break;
          case 'remove':
          case 'delete':
          case 'rm':      await cmdTaskRemove(api, opts, subArgs); break;
          case 'run':     await cmdTaskRun(api, opts, subArgs); break;
          case 'enable':  await cmdTaskSetEnabled(api, opts, subArgs, true); break;
          case 'disable': await cmdTaskSetEnabled(api, opts, subArgs, false); break;
          case 'status':  await cmdTaskStatus(api, opts, subArgs); break;
          default:
            error(`Unknown task subcommand: ${subcommand || '(none)'}`);
            error('Use: list | add | remove | run | enable | disable | status');
            process.exit(2);
        }
        break;
      }

      // ── worktree ─────────────────────────────────────────────────────────
      case 'worktree':
      case 'wt': {
        switch (subcommand) {
          case 'list':    await cmdWorktreeList(api, opts, subArgs); break;
          case 'create':  await cmdWorktreeCreate(api, opts, subArgs); break;
          case 'remove':
          case 'rm':      await cmdWorktreeRemove(api, opts, subArgs); break;
          case 'preview': await cmdWorktreePreview(api, opts, subArgs); break;
          default:
            error(`Unknown worktree subcommand: ${subcommand || '(none)'}`);
            error('Use: list | create | remove | preview');
            process.exit(2);
        }
        break;
      }

      // ── config ───────────────────────────────────────────────────────────
      case 'config':
      case 'cfg': {
        switch (subcommand) {
          case 'get':    await cmdConfigGet(api, opts, subArgs); break;
          case 'set':    await cmdConfigSet(api, opts, subArgs); break;
          case 'themes': await cmdConfigThemes(api, opts, subArgs); break;
          case 'reload': await cmdConfigReload(api, opts, subArgs); break;
          default:
            error(`Unknown config subcommand: ${subcommand || '(none)'}`);
            error('Use: get | set | themes | reload');
            process.exit(2);
        }
        break;
      }

      // ── server ───────────────────────────────────────────────────────────
      case 'server':
      case 'srv': {
        switch (subcommand) {
          case 'health': await cmdServerHealth(api, opts, subArgs); break;
          case 'info':   await cmdServerInfo(api, opts, subArgs); break;
          case 'status': await cmdServerStatus(api, opts, subArgs); break;
          default:
            error(`Unknown server subcommand: ${subcommand || '(none)'}`);
            error('Use: health | info | status');
            process.exit(2);
        }
        break;
      }

      default:
        error(`Unknown command: ${command}`);
        info('Run `occtl --help` for usage.');
        process.exit(2);
    }
  } catch (err) {
    fatal(err.message || String(err));
  }
}

main();
