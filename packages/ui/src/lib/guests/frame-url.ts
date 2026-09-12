import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

/**
 * The URL a guest iframe loads. It carries a token scoped to this guest's own
 * files, minted fresh per mount, so a guest that reads its `location` learns
 * nothing it could use against the rest of the API. Resolves at call time so
 * a runtime switch never reuses a URL minted for the previous instance.
 */
export const resolveGuestFrameUrl = async (guestId: string, entry: string): Promise<string> => {
  const token = await mintGuestFrameUrlAuthToken(guestId);
  return getRuntimeUrlResolver().assetWithUrlToken(`/api/guests/${guestId}/${entry}`, token, { oc_ui: 'issue-page' });
};
