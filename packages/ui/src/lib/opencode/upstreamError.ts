import { z } from 'zod';

/**
 * What an OpenCode error response actually said, kept on the thrown error so a
 * surface can tell the user something better than "500". `ref` is the id
 * OpenCode prints next to the stack in its own log, so quoting it turns a
 * vague failure into a line that can be found.
 */
export type UpstreamErrorDetail = {
  status?: number;
  name?: string;
  message?: string;
  ref?: string;
};

/** An OpenCode request that came back as an error response. */
export class OpencodeRequestError extends Error {
  readonly upstream: UpstreamErrorDetail;
  readonly status?: number;

  constructor(message: string, upstream: UpstreamErrorDetail) {
    super(message);
    this.name = 'OpencodeRequestError';
    this.upstream = upstream;
    if (upstream.status !== undefined) this.status = upstream.status;
  }
}

/** Shape of the error body OpenCode returns; the client parses with it at the boundary. */
export const upstreamErrorPayloadSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  data: z.object({
    message: z.string().optional(),
    ref: z.string().optional(),
  }).partial().optional(),
});

type UpstreamErrorPayload = z.infer<typeof upstreamErrorPayloadSchema>;

export const toUpstreamErrorDetail = (payload: UpstreamErrorPayload | undefined, status?: number): UpstreamErrorDetail => ({
  status,
  name: payload?.name,
  message: payload?.data?.message ?? payload?.message,
  ref: payload?.data?.ref,
});
