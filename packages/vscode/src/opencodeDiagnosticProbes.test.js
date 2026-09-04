import { describe, expect, it } from 'bun:test';

import {
  buildOpenCodeDiagnosticProbeUrl,
  getOpenCodeDiagnosticProbeTargets,
} from './opencodeDiagnosticProbes';

describe('OpenCode diagnostic probes', () => {
  it('uses generated OpenCode2 paths and their documented query shapes', () => {
    const targets = getOpenCodeDiagnosticProbeTargets('opencode2');
    const urls = Object.fromEntries(targets.map((target) => [
      target.label,
      buildOpenCodeDiagnosticProbeUrl('http://127.0.0.1:4096', target.path, '/repo', target.directoryQuery),
    ]));

    expect(urls.config).toBe('http://127.0.0.1:4096/api/config?location%5Bdirectory%5D=%2Frepo');
    expect(urls.sessions).toBe('http://127.0.0.1:4096/api/session?directory=%2Frepo');
    expect(urls.sessionStatus).toBe('http://127.0.0.1:4096/api/session/active');
  });

  it('keeps legacy paths and directory queries', () => {
    const targets = getOpenCodeDiagnosticProbeTargets('legacy');
    const sessions = targets.find((target) => target.label === 'sessions');
    const health = targets.find((target) => target.label === 'health');

    expect(buildOpenCodeDiagnosticProbeUrl(
      'http://127.0.0.1:4096',
      sessions.path,
      '/repo',
      sessions.directoryQuery,
    )).toBe('http://127.0.0.1:4096/session?directory=%2Frepo');
    expect(buildOpenCodeDiagnosticProbeUrl(
      'http://127.0.0.1:4096',
      health.path,
      '/repo',
      health.directoryQuery,
    )).toBe('http://127.0.0.1:4096/global/health');
  });
});
