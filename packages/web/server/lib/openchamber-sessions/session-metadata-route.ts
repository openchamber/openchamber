import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import { compareAndSetMetadata } from './session-metadata-store.js';
import type { MetadataDecider, SessionMetadata } from './session-metadata-store.js';
import type { Application, Response } from '../shared/http-contracts.js';
import express from 'express';

type MetadataPayload = { patch?: unknown; expected?: unknown; directory?: unknown };

const isMetadata = (value: unknown): value is SessionMetadata =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const metadataTarget = (sessionID: string | undefined, payload: MetadataPayload) => {
  const id = asNonEmptyString(sessionID);
  if (!id) throw new OpenChamberControlError('a session id is required', 400);
  if (!isMetadata(payload.patch)) throw new OpenChamberControlError('patch must be an object', 400);
  return { id, patch: payload.patch, directory: asNonEmptyString(payload.directory) || '' };
};

export async function setSessionMetadata(
  sessionID: string | undefined,
  payload: MetadataPayload,
  write: (id: string, patch: SessionMetadata, directory: string) => Promise<SessionMetadata | undefined>,
) {
  const { id, patch, directory } = metadataTarget(sessionID, payload);
  return { metadata: await write(id, patch, directory) };
}

export async function compareAndSetSessionMetadata(
  sessionID: string | undefined,
  payload: MetadataPayload,
  update: (id: string, decide: MetadataDecider, directory: string) => Promise<{ metadata: SessionMetadata | undefined }>,
) {
  const { id, patch, directory } = metadataTarget(sessionID, payload);
  if (!isMetadata(payload.expected)) throw new OpenChamberControlError('expected must be an object', 400);
  return compareAndSetMetadata(payload.expected, patch, (decide) => update(id, decide, directory));
}

export function registerConditionalMetadataRoute(
  app: Application,
  compareAndSet: (id: string | undefined, payload: MetadataPayload) => ReturnType<typeof compareAndSetSessionMetadata>,
  sendError: (res: Response, error: OpenChamberControlError, fallback: string) => Response,
) {
  app.post('/api/openchamber/sessions/:sessionId/metadata/compare-and-set', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await compareAndSet(req.params.sessionId, isMetadata(req.body) ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to conditionally store session metadata:', error);
      return sendError(res, asControlError(error, 'Failed to store session metadata'), 'Failed to store session metadata');
    }
  });
}
