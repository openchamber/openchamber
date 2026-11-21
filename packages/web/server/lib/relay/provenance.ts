import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isString } from '../shared/guards.js';

export const RELAY_PROOF_HEADER = 'x-openchamber-relay-proof';

const proof = randomBytes(32).toString('base64url');
const proofBytes = Buffer.from(proof, 'utf8');
interface RelayIngressRequest {
  headers?: IncomingHttpHeaders | undefined;
}

const relayRequests = new WeakSet<RelayIngressRequest>();

export const relayProofHeaders = () => ({ [RELAY_PROOF_HEADER]: proof });

const matchesProof = (value: string | string[]) => {
  if (!isString(value)) return false;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length === proofBytes.length && timingSafeEqual(bytes, proofBytes);
};

export const consumeRelayProof = (req: RelayIngressRequest) => {
  const value = req.headers?.[RELAY_PROOF_HEADER];
  if (value === undefined) return;
  delete req.headers?.[RELAY_PROOF_HEADER];
  if (matchesProof(value)) relayRequests.add(req);
};

export const hasRelayProvenance = (req: RelayIngressRequest | null | undefined) => req != null && relayRequests.has(req);
