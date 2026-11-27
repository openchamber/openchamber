import * as path from 'path';

import {
  createOpenCodeTrust,
  OPENCODE_TRUST_REQUIRED,
  type OpenCodeTrust,
  type OpenCodeTrustAnswer,
  type OpenCodeTrustRefusal,
} from '../../web/server/lib/opencode-trust/index.js';
import type { ProjectStartCommandSource } from '../../web/server/lib/opencode/project-start-command.js';
import { getOpenChamberDataDir } from './openchamberSessionState';

export const openCodeTrust = createOpenCodeTrust({ storePath: path.join(getOpenChamberDataDir(), 'opencode-trust.json') });

export type OpenCodeTrustGuard = Pick<OpenCodeTrust, 'refusalFor'>;

export class OpenCodeTrustRefusedError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly directory: string | undefined;

  constructor(message: string, options: { status: number; code?: string; directory?: string }) {
    super(message);
    this.name = 'OpenCodeTrustRefusedError';
    this.status = options.status;
    this.code = options.code;
    this.directory = options.directory;
  }
}

const isTrustRefusalBody = (body: OpenCodeTrustAnswer['body']): body is OpenCodeTrustRefusal => 'error' in body;

const refusalErrorFromAnswer = (answer: OpenCodeTrustAnswer): OpenCodeTrustRefusedError => {
  if (isTrustRefusalBody(answer.body)) {
    return new OpenCodeTrustRefusedError(answer.body.error, {
      status: answer.status,
      code: answer.body.code,
      directory: answer.body.directory,
    });
  }
  return new OpenCodeTrustRefusedError('OpenCode is paused for this folder until you trust its configuration', {
    status: answer.status,
    code: OPENCODE_TRUST_REQUIRED,
    directory: answer.body.directory,
  });
};

export const checkOpenCodeDirectoryTrust = async (
  directory: string | undefined,
  options: {
    method?: string;
    path?: string;
    trust?: OpenCodeTrustGuard;
  } = {},
): Promise<OpenCodeTrustAnswer | null> => {
  if (!directory) return null;
  const trust = options.trust ?? openCodeTrust;
  return trust.refusalFor({
    method: options.method ?? 'GET',
    path: options.path ?? '/api/location',
    headers: {
      'x-opencode-directory': encodeURIComponent(directory),
      'x-opencode-directory-encoding': 'uri',
    },
  });
};

export const assertOpenCodeDirectoryTrusted = async (
  directory: string | undefined,
  options: {
    method?: string;
    path?: string;
    trust?: OpenCodeTrustGuard;
  } = {},
): Promise<void> => {
  const refusal = await checkOpenCodeDirectoryTrust(directory, options);
  if (refusal) {
    throw refusalErrorFromAnswer(refusal);
  }
};

export const guardProjectStartCommandSource = (
  source: ProjectStartCommandSource,
  trust: OpenCodeTrustGuard = openCodeTrust,
): ProjectStartCommandSource => ({
  read: async (directory) => {
    await assertOpenCodeDirectoryTrusted(directory, { path: '/api/location', trust });
    return source.read(directory);
  },
});
