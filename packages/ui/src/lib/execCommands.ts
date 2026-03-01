import type { CommandExecResult, FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { resolveRuntimeApiBaseUrl } from '@/lib/instances/runtimeApiBaseUrl';
import { resolveSelectedInstance } from '@/stores/useInstancesStore';
import { getAccessToken } from '@/lib/auth/tokenStorage';

type ExecResult = { success: boolean; results: CommandExecResult[] };

const getBaseUrl = (): string => {
  return resolveRuntimeApiBaseUrl();
};

const getAuthHeaders = (): Record<string, string> => {
  const selectedInstance = resolveSelectedInstance();
  const token = selectedInstance ? getAccessToken(selectedInstance.id) : null;
  if (!token) {
    return { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
};

function getRuntimeFilesAPI(): FilesAPI | null {
  if (typeof window === 'undefined') return null;
  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
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

  const response = await fetch(`${getBaseUrl()}/fs/exec`, {
    method: 'POST',
    headers: getAuthHeaders(),
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
