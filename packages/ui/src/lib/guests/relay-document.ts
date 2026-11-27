import { guestFramePolicy } from '@openchamber/sdk';

import { inlineRelayHtmlDocument, toDataUrl, type LoadInlineAsset } from '@/lib/relay/inline-document';

const DOCUMENT_ORIGIN = 'https://extension.invalid';

export { toDataUrl };

export const loadRelayGuestDocument = async (
  guestId: string,
  entry: string,
  load: LoadInlineAsset,
  origins: readonly string[] = [],
): Promise<string> => inlineRelayHtmlDocument({
  origin: DOCUMENT_ORIGIN,
  prefix: `/api/guests/${guestId}/`,
  entry,
  load,
  csp: guestFramePolicy(null, origins),
  strictSubresources: true,
});
