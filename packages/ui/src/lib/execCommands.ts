import type { CommandExecResult, FilesAPI } from '@/lib/api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { runtimeFetch } from '@/lib/runtime-fetch';

type ExecResult = { success: boolean; results: CommandExecResult[] };

const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || '/api';

const getBaseUrl = (): string => {
  if (typeof DEFAULT_BASE_URL === 'string' && DEFAULT_BASE_URL.startsWith('/')) {
    return DEFAULT_BASE_URL;
  }
  return DEFAULT_BASE_URL;
};

function getRuntimeFilesAPI(): FilesAPI | null {
  const apis = getRegisteredRuntimeAPIs();
  if (apis?.files) {
    return apis.files;
  }
  return null;
}

export async function execCommands(commands: string[], cwd: string): Promise<ExecResult> {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.execCommands) {
    return runtimeFiles.execCommands(commands, cwd);
  }

  const response = await runtimeFetch(`${getBaseUrl()}/fs/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands, cwd, background: false }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((error as { error?: string }).error || 'Command exec failed');
  }

  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; results?: CommandExecResult[] }
    | null;

  return {
    success: Boolean(payload?.success),
    results: Array.isArray(payload?.results) ? payload!.results! : [],
  };
}

export async function execCommand(command: string, cwd: string): Promise<CommandExecResult> {
  const result = await execCommands([command], cwd);
  const first = result.results[0];
  if (!first) {
    return { command, success: result.success };
  }
  return first;
}
