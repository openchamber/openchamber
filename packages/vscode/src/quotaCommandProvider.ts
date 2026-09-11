import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: null;
  resetAfterFormatted: null;
  valueLabel?: string;
};

const CONFIG_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'usage-providers.json',
);

export const readUsageProviderCommands = (): Record<string, string[]> => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    const commands = config?.commands;
    if (config?.version !== 1 || !commands || typeof commands !== 'object' || Array.isArray(commands)) {
      throw new Error('Usage provider config is invalid');
    }
    const entries = Object.entries(commands);
    if (entries.some((entry) => (
      !Array.isArray(entry[1]) || entry[1].length === 0
        || !entry[1].every((part) => typeof part === 'string' && part.trim())
    ))) throw new Error('Usage provider config is invalid');
    return Object.fromEntries(entries) as Record<string, string[]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw new Error('Usage provider config is invalid', { cause: error });
  }
};

const toWindow = (limit: Record<string, unknown>): [string, UsageWindow] | null => {
  const minutes = typeof limit.windowMinutes === 'number' && Number.isFinite(limit.windowMinutes)
    ? limit.windowMinutes
    : null;
  const used = typeof limit.usedPercent === 'number' && Number.isFinite(limit.usedPercent)
    ? limit.usedPercent
    : null;
  const resetAt = typeof limit.resetAtMs === 'number' && Number.isFinite(limit.resetAtMs)
    ? limit.resetAtMs
    : null;
  if (minutes === null && used === null && resetAt === null) return null;
  const seconds = minutes === null ? null : minutes * 60;
  const label = seconds === null
    ? 'tokens'
    : seconds % 86_400 === 0
      ? seconds === 604_800 ? 'weekly' : `${seconds / 86_400}d`
      : seconds % 3_600 === 0 ? `${seconds / 3_600}h` : `${seconds}s`;
  return [label, {
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, 100 - used),
    windowSeconds: seconds,
    resetAfterSeconds: resetAt === null ? null : Math.max(0, Math.floor((resetAt - Date.now()) / 1000)),
    resetAt,
    resetAtFormatted: null,
    resetAfterFormatted: null,
  }];
};

export const fetchCommandQuota = async (providerId: string, command: string[], directory?: string) => {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command[0], command.slice(1), {
      cwd: directory || undefined,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, output) => {
      if (error && !output.trim()) {
        reject(new Error(error.killed ? 'Usage command timed out' : 'Usage command failed'));
        return;
      }
      resolve(output);
    });
  });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('Usage command returned invalid JSON');
  }
  if (payload.version !== 1 || !Array.isArray(payload.accounts)) {
    throw new Error('Usage command returned an unsupported payload');
  }

  const accounts = payload.accounts.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error('Usage command returned an invalid account');
    const account = raw as Record<string, unknown>;
    const windows = Object.fromEntries(
      (Array.isArray(account.limits) ? account.limits : [])
        .map((limit) => limit && typeof limit === 'object' ? toWindow(limit as Record<string, unknown>) : null)
        .filter((entry): entry is [string, UsageWindow] => entry !== null),
    );
    const credits = typeof account.credits === 'number'
      || (typeof account.credits === 'string' && account.credits.trim())
      ? Number(account.credits)
      : Number.NaN;
    if (Number.isFinite(credits)) {
      windows.credits_balance = {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: `$${credits.toFixed(2)}`,
      };
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

  return {
    providerId,
    providerName: typeof payload.providerName === 'string' && payload.providerName.trim() ? payload.providerName : providerId,
    ok: accounts.some((account) => Object.keys(account.windows).length > 0),
    configured: true,
    usage: { windows: {}, accounts },
    fetchedAt: Date.now(),
  };
};
