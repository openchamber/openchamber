import { z } from 'zod';
import type { Application, Request } from '../shared/http-contracts.js';

export interface HealthRouteDependencies {
  app: Application;
  getHealthSnapshot: () => object;
  resolveServerId: () => Promise<string | null>;
  openchamberVersion: string;
  runtimeName: string;
  compatibility: object;
  isLocalPeer: (req: Request) => boolean;
}

const UNCLASSIFIED_START_ERROR = 'OpenCode failed to start; details are available on the server machine';
const CONFIGURED_BINARY_HINT = 'OpenChamber needs the standalone opencode CLI. Install it and set settings.opencodeBinary to the CLI path, for example ~/.opencode/bin/opencode, or leave the setting empty to use PATH lookup.';

const START_ERROR_SUMMARIES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^OpenCode process exited before serving with code (-?\d{1,5})\b/, (match) => `OpenCode process exited before serving with code ${match[1]}`],
  [/^OpenCode process exited before serving with signal ([A-Z]{3,10})\b/, (match) => `OpenCode process exited before serving with signal ${match[1]}`],
  [/^Timeout waiting for OpenCode to start\b/, () => 'Timeout waiting for OpenCode to start'],
  [/^Timed out waiting for OpenCode port\b/, () => 'Timed out waiting for OpenCode port'],
  [/^Timed out waiting for OpenCode to become ready\b/, () => 'Timed out waiting for OpenCode to become ready'],
  [/^Server started but health check failed\b/, () => 'Server started but health check failed'],
  [/^External OpenCode server on port (\d{1,5}) is not responding$/, (match) => `External OpenCode server on port ${match[1]} is not responding`],
  [/did not identify itself as OpenCode 2\.x/, () => 'The OpenCode server did not identify itself as OpenCode 2.x'],
  [/through WSL is no longer supported/, () => 'Running OpenCode through WSL is no longer supported'],
  [
    /^Configured OpenCode binary (points at the (?:Windows desktop app install|macOS desktop app bundle), not the CLI|directory does not contain an executable opencode(?:\.exe)?|is not a file|is not executable|not found): /,
    (match) => `Configured OpenCode binary ${match[1]}. ${CONFIGURED_BINARY_HINT}`,
  ],
  [/\bENOENT$/, () => 'OpenCode binary not found (ENOENT)'],
  [/\bEACCES$/, () => 'OpenCode binary is not executable (EACCES)'],
];

export const summarizeStartError = (message: string | null): string | null => {
  if (!message?.trim()) return null;
  for (const [pattern, summarize] of START_ERROR_SUMMARIES) {
    const match = pattern.exec(message);
    if (match) return summarize(match);
  }
  return UNCLASSIFIED_START_ERROR;
};

const publicHealthSchema = z.object({
  openCodePort: z.number().int().nullable().catch(null),
  openCodeRunning: z.boolean().optional().catch(undefined),
  isOpenCodeReady: z.boolean().optional().catch(undefined),
  openCodeSecureConnection: z.boolean().optional().catch(undefined),
  openCodeAuthSource: z.string().nullable().catch(null),
  opencodeBinarySource: z.literal('shared-service').optional().catch(undefined),
  lastOpenCodeError: z.string().nullable().catch(null).transform(summarizeStartError),
  lastOpenCodeHealthFailure: z.object({
    class: z.enum(['timeout', 'connection_refused', 'connection_reset', 'invalid_response', 'error']).catch('error'),
    at: z.string().nullable().catch(null),
  }).nullable().catch(null),
  lastOpenCodeRestartDiagnostics: z.object({
    at: z.string().nullable().catch(null),
    busySessionCount: z.number().int().nonnegative().nullable().catch(null),
  }).nullable().catch(null),
});

export const registerHealthRoute = ({ app, getHealthSnapshot, resolveServerId, openchamberVersion, runtimeName, compatibility, isLocalPeer }: HealthRouteDependencies) => {
  app.get('/health', async (req, res) => {
    const serverId = await resolveServerId();
    const identity: Record<string, string> = {};
    if (serverId) identity.serverId = serverId;
    const liveness = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      openchamberVersion,
      runtime: runtimeName,
      compatibility,
      ...identity,
    };
    const snapshot = getHealthSnapshot();
    if (isLocalPeer(req)) {
      return res.json({ ...liveness, ...snapshot });
    }
    return res.json({ ...liveness, ...publicHealthSchema.parse(snapshot) });
  });
};
