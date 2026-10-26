import { z } from 'zod';

const pairingTokenSchema = z.object({ clientToken: z.string().trim().min(1) });
const rejectedPairingSchema = z.object({ error: z.literal('Invalid or expired pairing session') });

type PairingResponse =
  | { kind: 'success'; token: string }
  | { kind: 'rejected' }
  | { kind: 'http-error'; status: number }
  | { kind: 'invalid-response' };

export const readPairingResponse = async (response: Response): Promise<PairingResponse> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 400 && rejectedPairingSchema.safeParse(body).success) {
      return { kind: 'rejected' };
    }
    return { kind: 'http-error', status: response.status };
  }
  const parsed = pairingTokenSchema.safeParse(body);
  return parsed.success
    ? { kind: 'success', token: parsed.data.clientToken }
    : { kind: 'invalid-response' };
};
