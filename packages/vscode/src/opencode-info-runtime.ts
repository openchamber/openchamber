import { z } from 'zod';
import {
  OPENCODE_INFO_RESPONSE_MAX_BYTES,
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from './bounded-response-body';

const openCodeInfoSchema = z.object({
  version: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

type OpenCodeInfoPayload = z.infer<typeof openCodeInfoSchema>;

export const readOpenCodeInfoResponse = async (response: Response): Promise<OpenCodeInfoPayload | null> => {
  try {
    return await readBoundedResponseJson(response, OPENCODE_INFO_RESPONSE_MAX_BYTES, openCodeInfoSchema);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) throw error;
    return null;
  }
};
