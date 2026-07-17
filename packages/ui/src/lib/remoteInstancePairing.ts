import type { PairingConnectionPayload } from './connectionPayload';
import {
  pairingFailureMessageKey,
  redeemPairingCandidate,
  type PairingFailureMessageKey,
  type PairingRedeemedTransport,
  type PairingRedemptionOptions,
} from './pairingCandidateRedemption';

export type RemoteInstancePairingResult =
  | { ok: true; token: string; transport: PairingRedeemedTransport }
  | { ok: false; errorKey: PairingFailureMessageKey };

export const redeemRemoteInstancePairing = async (
  payload: PairingConnectionPayload,
  options: PairingRedemptionOptions,
  redeem: typeof redeemPairingCandidate = redeemPairingCandidate,
): Promise<RemoteInstancePairingResult> => {
  try {
    const redeemed = await redeem(payload, options);
    return { ok: true, ...redeemed };
  } catch (error) {
    return { ok: false, errorKey: pairingFailureMessageKey(error) };
  }
};
