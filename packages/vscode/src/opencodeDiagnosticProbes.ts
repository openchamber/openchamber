import type { OpenCodeProtocol } from './opencode';

export type OpenCodeDiagnosticProbeTarget = {
  label: string;
  path: string;
  directoryQuery?: 'directory' | 'location[directory]' | false;
  timeoutMs?: number;
};

export const getOpenCodeDiagnosticProbeTargets = (
  protocol: OpenCodeProtocol | null,
): OpenCodeDiagnosticProbeTarget[] => protocol === 'opencode2'
  ? [
      { label: 'health', path: '/api/health', directoryQuery: false },
      { label: 'config', path: '/api/config', directoryQuery: 'location[directory]' },
      { label: 'providers', path: '/api/provider', directoryQuery: 'location[directory]' },
      { label: 'agents', path: '/api/agent', directoryQuery: 'location[directory]', timeoutMs: 12000 },
      { label: 'commands', path: '/api/command', directoryQuery: 'location[directory]', timeoutMs: 10000 },
      { label: 'project', path: '/api/project/current', directoryQuery: 'location[directory]' },
      { label: 'path', path: '/api/location', directoryQuery: 'location[directory]' },
      { label: 'sessions', path: '/api/session', directoryQuery: 'directory', timeoutMs: 12000 },
      { label: 'sessionStatus', path: '/api/session/active', directoryQuery: false },
    ]
  : [
      { label: 'health', path: '/global/health', directoryQuery: false },
      { label: 'config', path: '/config' },
      { label: 'providers', path: '/config/providers' },
      { label: 'agents', path: '/agent', timeoutMs: 12000 },
      { label: 'commands', path: '/command', timeoutMs: 10000 },
      { label: 'project', path: '/project/current' },
      { label: 'path', path: '/path' },
      { label: 'sessions', path: '/session', timeoutMs: 12000 },
      { label: 'sessionStatus', path: '/session/status' },
    ];

export const buildOpenCodeDiagnosticProbeUrl = (
  baseUrl: string,
  pathname: string,
  workingDirectory: string,
  directoryQuery: OpenCodeDiagnosticProbeTarget['directoryQuery'] = 'directory',
): string => {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  if (directoryQuery && workingDirectory) {
    url.searchParams.set(directoryQuery, workingDirectory);
  }
  return url.toString();
};
