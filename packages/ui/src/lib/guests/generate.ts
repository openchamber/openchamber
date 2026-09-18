import { z } from 'zod';

import {
  GUEST_GENERATE_TEXT_MAX,
  resolveHostRequestErrorCode,
  type GenerateRequest,
  type GenerateResult,
  type HostRequestErrorCode,
} from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

export type GuestGenerateProxyResult =
  | { ok: true; result: GenerateResult }
  | { ok: false; code: HostRequestErrorCode; message: string };

const successSchema = z.object({
  ok: z.literal(true),
  result: z.object({ text: z.string().max(GUEST_GENERATE_TEXT_MAX) }),
});

const failureSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
});

const failed = (code: HostRequestErrorCode, message: string): GuestGenerateProxyResult => ({ ok: false, code, message });

const FAILED_MESSAGE = 'Text generation failed.';

const parseGuestGenerateResponse = async (response: Response): Promise<GuestGenerateProxyResult> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = failureSchema.safeParse(body);
    if (!parsed.success) {
      return failed('HOST_REJECTED', FAILED_MESSAGE);
    }
    return failed(resolveHostRequestErrorCode(parsed.data.error), parsed.data.message ?? parsed.data.error);
  }
  const parsed = successSchema.safeParse(body);
  if (!parsed.success) {
    return failed('HOST_REJECTED', FAILED_MESSAGE);
  }
  return { ok: true, result: parsed.data.result };
};

/**
 * One-off text generation for a guest through the server's Small Model,
 * which resolves and authenticates the model itself. The open project only
 * informs which OpenCode config decides the model; it never enters the prompt.
 */
export const guestGenerate = async (
  guestId: string,
  request: GenerateRequest,
  directory: string | null,
): Promise<GuestGenerateProxyResult> => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (directory) {
    headers.set('x-opencode-directory', directory);
  }
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    return parseGuestGenerateResponse(response);
  } catch {
    return failed('HOST_REJECTED', FAILED_MESSAGE);
  }
};
