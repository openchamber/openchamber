import { z } from 'zod';

import {
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_ENTRY_KINDS,
  GUEST_FILE_LIST_MAX,
  GUEST_FILE_STAT_KINDS,
  resolveHostRequestErrorCode,
  type FileListResult,
  type FileReadResult,
  type FileStatResult,
  type FileWriteResult,
  type HostRequestErrorCode,
} from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

/** Body of `POST /api/guests/:id/files`. One request per host message type. */
export type GuestFileRequest =
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'list'; path: string }
  | { op: 'stat'; path: string };

export type GuestFileResult = FileReadResult | FileWriteResult | FileListResult | FileStatResult;

export type GuestFileProxyResult =
  | { ok: true; result: GuestFileResult }
  | { ok: false; code: HostRequestErrorCode; message: string };

const fileResultSchema = z.union([
  z.object({ content: z.string().max(GUEST_FILE_CONTENT_MAX) }),
  z.object({ written: z.literal(true) }),
  z.object({
    entries: z.array(z.object({
      name: z.string().min(1),
      kind: z.enum(GUEST_FILE_ENTRY_KINDS),
    })).max(GUEST_FILE_LIST_MAX),
  }),
  z.object({
    kind: z.enum(GUEST_FILE_STAT_KINDS),
    size: z.number().int().min(0),
    mtime: z.number().int().min(0),
  }),
]);

const successSchema = z.object({
  ok: z.literal(true),
  result: fileResultSchema,
});

const failureSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
});

const failed = (code: HostRequestErrorCode, message: string): GuestFileProxyResult => ({ ok: false, code, message });

const parseGuestFileResponse = async (response: Response): Promise<GuestFileProxyResult> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = failureSchema.safeParse(body);
    if (!parsed.success) {
      return failed('HOST_REJECTED', 'File operation failed.');
    }
    return failed(resolveHostRequestErrorCode(parsed.data.error), parsed.data.message ?? parsed.data.error);
  }
  const parsed = successSchema.safeParse(body);
  if (!parsed.success) {
    return failed('HOST_REJECTED', 'File operation failed.');
  }
  return { ok: true, result: parsed.data.result };
};

/**
 * Runs one guest file operation on the server. `directory` is the open
 * project; relative paths resolve against it, so it travels as the usual
 * `x-opencode-directory` header.
 */
export const guestFileOperation = async (
  guestId: string,
  request: GuestFileRequest,
  directory: string | null,
): Promise<GuestFileProxyResult> => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (directory) {
    headers.set('x-opencode-directory', directory);
  }
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/files`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    return parseGuestFileResponse(response);
  } catch {
    return failed('HOST_REJECTED', 'File operation failed.');
  }
};
