import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * The URL a guest iframe loads. It carries a token scoped to this guest's own
 * files, minted fresh per mount, so a guest that reads its `location` learns
 * nothing it could use against the rest of the API. Resolves at call time so
 * a runtime switch never reuses a URL minted for the previous instance.
 */
export type GuestFrameUrl = { url: string; expiresAt: number };

export const resolveGuestFrameUrl = async (guestId: string, entry: string): Promise<GuestFrameUrl> => {
  const runtimeKey = getRuntimeKey();
  const { token, expiresAt } = await mintGuestFrameUrlAuthToken(guestId);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  return {
    url: getRuntimeUrlResolver().assetWithUrlToken(`/api/guests/${guestId}/${entry}`, token, { oc_ui: 'issue-page' }),
    expiresAt,
  };
};
