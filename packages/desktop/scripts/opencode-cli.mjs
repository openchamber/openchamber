#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, '..');
const stateFile = path.join(desktopDir, '.opencode-cli-state.json');
const DEFAULT_BIN_CANDIDATES = [
  process.env.ALIAS_ADE_OPENCODE_PATH,
  process.env.ALIAS_ADE_OPENCODE_BIN,
  process.env.OPENCODE_PATH,
  process.env.OPENCODE_BINARY,
  '/opt/homebrew/bin/opencode',
  '/usr/local/bin/opencode',
  '/usr/bin/opencode',
  path.join(os.homedir(), '.local/bin/opencode'),
].filter(Boolean);
const CLI_ARGS_ENV = process.env.ALIAS_ADE_OPENCODE_ARGS;
const DEFAULT_ARGS = CLI_ARGS_ENV
  ? parseArgs(CLI_ARGS_ENV)
  : ['api'];

function parseArgs(raw) {
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    } catch {
      // fall through to whitespace split
    }
  }
  return trimmed.split(/\s+/g);
}

async function fileExists(targetPath) {
  try {
    await access(targetPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliPath() {
  for (const candidate of DEFAULT_BIN_CANDIDATES) {
    if (candidate && await fileExists(candidate)) {
      return candidate;
    }
  }

  const envPath = process.env.PATH || '';
  for (const segment of envPath.split(path.delimiter)) {
    const candidate = path.join(segment, 'opencode');
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to locate the OpenCode CLI. Set ALIAS_ADE_OPENCODE_PATH to the executable.');
}

async function readState() {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data?.pid === 'number') {
      return data;
    }
  } catch {
    // ignore
  }
  return null;
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeState(pid) {
  await writeFile(stateFile, JSON.stringify({ pid }), 'utf8');
}

async function removeStateFile() {
  try {
    await unlink(stateFile);
  } catch {
    // already removed
  }
}

function spawnCli(cliPath, args) {
  const env = {
    ...process.env,
    ALIAS_ADE_OPENCODE_PORT: process.env.ALIAS_ADE_OPENCODE_PORT || process.env.OPENCODE_PORT || process.env.ALIAS_ADE_INTERNAL_PORT || '0',
  };
  const cwd = process.env.ALIAS_ADE_OPENCODE_CWD || process.cwd();

  const child = spawn(cliPath, args.length > 0 ? args : DEFAULT_ARGS, {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  return child;
}

export async function startCli({ silent = false } = {}) {
  const existing = await readState();
  if (existing?.pid && isProcessAlive(existing.pid)) {
    if (!silent) {
      console.log(`[desktop:start-cli] OpenCode CLI already running (pid ${existing.pid}).`);
    }
    return existing.pid;
  }

  const cliPath = await resolveCliPath();
  const child = spawnCli(cliPath, DEFAULT_ARGS);
  await writeState(child.pid);
  if (!silent) {
    console.log(`[desktop:start-cli] OpenCode CLI started (${cliPath}) pid ${child.pid}.`);
  }
  return child.pid;
}

export async function stopCli({ silent = false } = {}) {
  const state = await readState();
  if (!state?.pid) {
    if (!silent) {
      console.log('[desktop:stop-cli] No OpenCode CLI PID recorded.');
    }
    return;
  }

  const { pid } = state;
  if (!isProcessAlive(pid)) {
    await removeStateFile();
    if (!silent) {
      console.log('[desktop:stop-cli] CLI already stopped.');
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!silent) {
      console.error(`[desktop:stop-cli] Failed to send SIGTERM to pid ${pid}:`, error);
    }
  }

  const timeoutMs = 5000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      await removeStateFile();
      if (!silent) {
        console.log('[desktop:stop-cli] OpenCode CLI stopped.');
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    process.kill(pid, 'SIGKILL');
    if (!silent) {
      console.warn(`[desktop:stop-cli] Forced termination sent to pid ${pid}.`);
    }
  } catch (error) {
    if (!silent) {
      console.error(`[desktop:stop-cli] Unable to terminate pid ${pid}:`, error);
    }
  } finally {
    await removeStateFile();
  }
}

async function main() {
  const [, , command] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: node opencode-cli.mjs <start|stop|status>');
    process.exit(0);
  }

  if (command === 'start') {
    await startCli();
    return;
  }
  if (command === 'stop') {
    await stopCli();
    return;
  }
  if (command === 'status') {
    const state = await readState();
    if (state?.pid && isProcessAlive(state.pid)) {
      console.log(`OpenCode CLI running (pid ${state.pid}).`);
    } else {
      console.log('OpenCode CLI not running.');
    }
    process.exit(0);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('[desktop:opencode-cli] Unexpected error:', error);
    process.exit(1);
  });
}
