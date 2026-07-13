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
const SLOT_COUNT = Number(process.env.OPENCHAMBER_WORKTREE_SLOT_COUNT || 200);

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
  return parseWorktrees(raw).sort((a, b) => a.path.localeCompare(b.path));
}

function getCurrentWorktreePath() {
  return path.resolve(runGit(['rev-parse', '--show-toplevel']));
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function deriveSlot(worktreePath) {
  if (!Number.isInteger(SLOT_COUNT) || SLOT_COUNT <= 0) {
    throw new Error('OPENCHAMBER_WORKTREE_SLOT_COUNT must be a positive integer.');
  }
  return fnv1a32(worktreePath) % SLOT_COUNT;
}

function derivePortsFromSlot(slot) {
  const uiPort = UI_BASE_PORT + (slot * PORT_STEP);
  const apiPort = API_BASE_PORT + (slot * PORT_STEP);
  if (uiPort > 65535 || apiPort > 65535) {
    throw new Error('Derived ports exceed 65535. Adjust base/step/slot-count overrides.');
  }
  return { uiPort, apiPort };
}

function withPorts(worktrees) {
  return worktrees.map((worktree) => {
    const slot = deriveSlot(worktree.path);
    const ports = derivePortsFromSlot(slot);
    return {
      ...worktree,
      slot,
      ...ports,
    };
  });
}

function buildCollisionMap(worktrees) {
  const bySlot = new Map();
  for (const worktree of worktrees) {
    const records = bySlot.get(worktree.slot) || [];
    records.push(worktree);
    bySlot.set(worktree.slot, records);
  }
  return bySlot;
}

function applyCollisionFlags(worktrees) {
  const bySlot = buildCollisionMap(worktrees);
  return worktrees.map((worktree) => ({
    ...worktree,
    hasCollision: (bySlot.get(worktree.slot)?.length || 0) > 1,
    conflictingWorktrees: (bySlot.get(worktree.slot) || []).map((entry) => entry.path),
  }));
}

function getCurrentPortConfig(worktrees) {
  const currentPath = getCurrentWorktreePath();
  const current = worktrees.find((worktree) => worktree.path === currentPath);

  if (!current) {
    throw new Error('Current directory is not inside a git worktree for this repository.');
  }

  return current;
}

function resolveAllWorktrees() {
  return applyCollisionFlags(withPorts(getWorktrees()));
}

function validateExplicitPorts() {
  const explicitUi = process.env.OPENCHAMBER_HMR_UI_PORT;
  const explicitApi = process.env.OPENCHAMBER_HMR_API_PORT;
  if (!explicitUi && !explicitApi) return null;
  if (!explicitUi || !explicitApi) {
    throw new Error('Set both OPENCHAMBER_HMR_UI_PORT and OPENCHAMBER_HMR_API_PORT together.');
  }

  const uiPort = Number(explicitUi);
  const apiPort = Number(explicitApi);
  if (!Number.isInteger(uiPort) || !Number.isInteger(apiPort)) {
    throw new Error('Explicit OPENCHAMBER_HMR_* ports must be integers.');
  }
  return { uiPort, apiPort };
}

function printInfo(config) {
  console.log(`[worktree-dev] worktree: ${config.path}`);
  console.log(`[worktree-dev] branch: ${config.branch || '(detached)'}`);
  console.log(`[worktree-dev] slot: ${config.slot}/${SLOT_COUNT}`);
  console.log(`[worktree-dev] OPENCHAMBER_HMR_UI_PORT=${config.uiPort}`);
  console.log(`[worktree-dev] OPENCHAMBER_HMR_API_PORT=${config.apiPort}`);
  console.log(`[worktree-dev] UI URL: http://127.0.0.1:${config.uiPort}`);
  console.log(`[worktree-dev] API URL: http://127.0.0.1:${config.apiPort}`);
  if (config.hasCollision) {
    console.warn('[worktree-dev] WARNING: slot collision detected with:');
    for (const worktreePath of config.conflictingWorktrees) {
      if (worktreePath !== config.path) {
        console.warn(`  - ${worktreePath}`);
      }
    }
    console.warn('[worktree-dev] Set explicit OPENCHAMBER_HMR_UI_PORT and OPENCHAMBER_HMR_API_PORT to override.');
  }
}

function printEnv(config) {
  console.log(`export OPENCHAMBER_HMR_UI_PORT=${config.uiPort}`);
  console.log(`export OPENCHAMBER_HMR_API_PORT=${config.apiPort}`);
}

function runDev(config) {
  const explicitPorts = validateExplicitPorts();
  if (config.hasCollision && !explicitPorts) {
    throw new Error('Port collision detected for this worktree. Set explicit OPENCHAMBER_HMR_UI_PORT and OPENCHAMBER_HMR_API_PORT.');
  }
  const uiPort = explicitPorts?.uiPort ?? config.uiPort;
  const apiPort = explicitPorts?.apiPort ?? config.apiPort;

  if (explicitPorts) {
    console.log('[worktree-dev] using explicit OPENCHAMBER_HMR_* port overrides');
  }
  printInfo(config);
  const child = spawnSync('bun', ['run', 'dev:web:hmr'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENCHAMBER_HMR_UI_PORT: String(uiPort),
      OPENCHAMBER_HMR_API_PORT: String(apiPort),
    },
  });

  process.exit(child.status ?? 1);
}

function printList() {
  const worktrees = resolveAllWorktrees();
  for (const entry of worktrees) {
    const branch = entry.branch || '(detached)';
    const collisionFlag = entry.hasCollision ? ' !collision' : '';
    console.log(`${entry.uiPort}/${entry.apiPort}  slot=${entry.slot}  ${branch}  ${entry.path}${collisionFlag}`);
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
  OPENCHAMBER_WORKTREE_SLOT_COUNT     (default: 200)

Optional runtime overrides (for collision/manual assignment):
  OPENCHAMBER_HMR_UI_PORT
  OPENCHAMBER_HMR_API_PORT
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

    const config = getCurrentPortConfig(resolveAllWorktrees());
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
