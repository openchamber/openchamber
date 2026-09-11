import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResult, formatMoney, resolveWindowLabel, toUsageWindow } from './utils/index.js';

const CONFIG_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'usage-providers.json',
);
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const parseUsageProviderCommands = (config) => {
  if (config?.version !== 1 || !config.commands || typeof config.commands !== 'object' || Array.isArray(config.commands)) {
    throw new Error('Usage provider config is invalid');
  }
  const commands = Object.entries(config.commands);
  if (commands.some(([, command]) => (
    !Array.isArray(command) || command.length === 0
      || !command.every((part) => typeof part === 'string' && part.trim())
  ))) throw new Error('Usage provider config is invalid');
  return Object.fromEntries(commands);
};

export const readUsageProviderCommands = () => {
  try {
    return parseUsageProviderCommands(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('Usage provider config is invalid', { cause: error });
  }
};

export const readUsageProviderCommand = (providerId) => readUsageProviderCommands()[providerId] ?? null;

const runCommand = (command, directory) => new Promise((resolve, reject) => {
  execFile(command[0], command.slice(1), {
    cwd: directory || undefined,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  }, (error, stdout) => {
    if (error && !stdout.trim()) {
      reject(new Error(error.killed ? 'Usage command timed out' : 'Usage command failed'));
      return;
    }
    resolve(stdout);
  });
});

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeWindow = (limit) => {
  const windowMinutes = finiteNumber(limit?.windowMinutes);
  const usedPercent = finiteNumber(limit?.usedPercent);
  const resetAt = finiteNumber(limit?.resetAtMs);
  if (usedPercent === null && resetAt === null && windowMinutes === null) return null;
  return {
    label: resolveWindowLabel(windowMinutes === null ? null : windowMinutes * 60),
    window: toUsageWindow({
      usedPercent,
      windowSeconds: windowMinutes === null ? null : windowMinutes * 60,
      resetAt,
    }),
  };
};

export const parseUsageCommandOutput = ({ providerId, providerName, stdout }) => {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('Usage command returned invalid JSON');
  }
  if (payload?.version !== 1 || !Array.isArray(payload.accounts)) {
    throw new Error('Usage command returned an unsupported payload');
  }

  const accounts = payload.accounts.map((account, index) => {
    if (!account || typeof account !== 'object') throw new Error('Usage command returned an invalid account');
    const windows = {};
    for (const limit of Array.isArray(account.limits) ? account.limits : []) {
      const normalized = normalizeWindow(limit);
      if (normalized) windows[normalized.label] = normalized.window;
    }
    const credits = typeof account.credits === 'number'
      || (typeof account.credits === 'string' && account.credits.trim())
      ? Number(account.credits)
      : Number.NaN;
    if (Number.isFinite(credits)) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(credits)}`,
      });
    }
    return {
      id: typeof account.id === 'string' && account.id.trim() ? account.id : `account-${index + 1}`,
      label: typeof account.label === 'string' && account.label.trim() ? account.label : `Account ${index + 1}`,
      ...(typeof account.email === 'string' && account.email.trim() ? { detail: account.email } : {}),
      current: account.current === true,
      available: account.available !== false,
      ...(typeof account.status === 'string' && account.status.trim() ? { status: account.status } : {}),
      ...(typeof account.planType === 'string' && account.planType.trim() ? { planLabel: account.planType } : {}),
      ...(typeof account.error === 'string' && account.error.trim() ? { error: account.error } : {}),
      windows,
    };
  });

  return buildResult({
    providerId,
    providerName: typeof payload.providerName === 'string' && payload.providerName.trim()
      ? payload.providerName
      : providerName,
    ok: accounts.some((account) => Object.keys(account.windows).length > 0),
    configured: true,
    usage: { windows: {}, accounts },
  });
};

export const fetchCommandQuota = async ({ providerId, providerName, command, directory }) =>
  parseUsageCommandOutput({ providerId, providerName, stdout: await runCommand(command, directory) });
