#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const UI_BASE_PORT = Number(process.env.OPENCHAMBER_WORKTREE_UI_BASE_PORT || 5180);
const API_BASE_PORT = Number(process.env.OPENCHAMBER_WORKTREE_API_BASE_PORT || 3902);
const PORT_STEP = Number(process.env.OPENCHAMBER_WORKTREE_PORT_STEP || 20);

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'git command failed');
  }

  return result.stdout.trim();
}

function parseWorktrees(raw) {
  const records = [];
  const chunks = raw.split('\n\n').map((chunk) => chunk.trim()).filter(Boolean);

  for (const chunk of chunks) {
    const record = {};
    for (const line of chunk.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') record.path = path.resolve(value);
      if (key === 'branch') record.branch = value.replace('refs/heads/', '');
    }
    if (record.path) records.push(record);
  }

  return records;
}

function getWorktrees() {
  const raw = runGit(['worktree', 'list', '--porcelain']);
  return parseWorktrees(raw);
}

function findCurrentWorktree(worktrees) {
  const cwd = path.resolve(process.cwd());
  let best = null;

  for (const worktree of worktrees) {
    const prefix = `${worktree.path}${path.sep}`;
    if (cwd === worktree.path || cwd.startsWith(prefix)) {
      if (!best || worktree.path.length > best.path.length) {
        best = worktree;
      }
    }
  }

  return best;
}

function withPorts(worktrees) {
  return worktrees.map((worktree, index) => ({
    ...worktree,
    index,
    uiPort: UI_BASE_PORT + (index * PORT_STEP),
    apiPort: API_BASE_PORT + (index * PORT_STEP),
  }));
}

function getCurrentPortConfig() {
  const worktrees = withPorts(getWorktrees());
  const current = findCurrentWorktree(worktrees);

  if (!current) {
    throw new Error('Current directory is not inside a git worktree for this repository.');
  }

  return current;
}

function printInfo(config) {
  console.log(`[worktree-dev] worktree: ${config.path}`);
  console.log(`[worktree-dev] branch: ${config.branch || '(detached)'}`);
  console.log(`[worktree-dev] OPENCHAMBER_HMR_UI_PORT=${config.uiPort}`);
  console.log(`[worktree-dev] OPENCHAMBER_HMR_API_PORT=${config.apiPort}`);
  console.log(`[worktree-dev] UI URL: http://127.0.0.1:${config.uiPort}`);
  console.log(`[worktree-dev] API URL: http://127.0.0.1:${config.apiPort}`);
}

function printEnv(config) {
  console.log(`export OPENCHAMBER_HMR_UI_PORT=${config.uiPort}`);
  console.log(`export OPENCHAMBER_HMR_API_PORT=${config.apiPort}`);
}

function runDev(config) {
  printInfo(config);
  const child = spawnSync('bun', ['run', 'dev:web:hmr'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENCHAMBER_HMR_UI_PORT: String(config.uiPort),
      OPENCHAMBER_HMR_API_PORT: String(config.apiPort),
    },
  });

  process.exit(child.status ?? 1);
}

function printList() {
  const worktrees = withPorts(getWorktrees());
  for (const entry of worktrees) {
    const branch = entry.branch || '(detached)';
    console.log(`${entry.uiPort}/${entry.apiPort}  ${branch}  ${entry.path}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/worktree-dev.mjs [info|env|run|list]

Commands:
  info   Print current worktree ports and URLs (default)
  env    Print export commands for current worktree ports
  run    Start bun run dev:web:hmr with current worktree ports
  list   Print all worktrees with their assigned UI/API port pairs

Optional env overrides:
  OPENCHAMBER_WORKTREE_UI_BASE_PORT   (default: 5180)
  OPENCHAMBER_WORKTREE_API_BASE_PORT  (default: 3902)
  OPENCHAMBER_WORKTREE_PORT_STEP      (default: 20)
`);
}

function main() {
  const command = process.argv[2] || 'info';
  if (command === '-h' || command === '--help' || command === 'help') {
    printHelp();
    return;
  }

  try {
    if (command === 'list') {
      printList();
      return;
    }

    const config = getCurrentPortConfig();
    if (command === 'info') {
      printInfo(config);
      return;
    }
    if (command === 'env') {
      printEnv(config);
      return;
    }
    if (command === 'run') {
      runDev(config);
      return;
    }

    printHelp();
    process.exit(1);
  } catch (error) {
    console.error(`[worktree-dev] ${error.message}`);
    process.exit(1);
  }
}

main();
