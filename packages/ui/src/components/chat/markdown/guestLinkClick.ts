import { clampAttachRequest } from '@openchamber/sdk';

import { toast } from '@/components/ui';
import { guestMay } from '@/lib/guests/capabilities';
import { openGuestWithItem } from '@/lib/guests/dialog-store';
import type { GuestLinkClaim } from '@/lib/guests/links';
import { useGuestsStore } from '@/lib/guests/store';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { commitShaOfUrl } from '@/lib/source-control/repositoryLinks';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { useInputStore } from '@/sync/input-store';

/**
 * Whether one of the app's own link readers claims the URL: a tracker item
 * (built in or an extension tracker), a repository issue or change request, or
 * a commit. Those keep their routes whatever the user's settings make of them,
 * so an extension never takes a link the app already knows. Read at click
 * time, so a chat link renders without these subscriptions.
 */
export const isBuiltInLink = (url: string): boolean => {
  const descriptors = useSourceControlProviderRegistry.getState().ordered;
  if (createTrackerUrlMatcher(useTrackerRegistry.getState().ordered)(url)) return true;
  if (createRepositoryUrlMatcher(descriptors, useSourceControlAuthStore.getState().identities).match(url)) return true;
  return commitShaOfUrl(url, descriptors) !== null;
};

/**
 * Does what the extension declared for a clicked identifier or link: opens it
 * with a `link` item, or puts a chip on the composer. False when the
 * extension is no longer active, or when a clicked `link` cannot open in a
 * panel with no project here, so the click keeps its usual meaning; an
 * identifier has no other meaning, so it says why instead.
 */
export const runGuestLink = (
  claim: GuestLinkClaim,
  clicked: 'identifier' | 'link',
  directory: string,
  t: (key: I18nKey, params?: I18nParams) => string,
): boolean => {
  const guest = useGuestsStore.getState().guests.find((candidate) => candidate.id === claim.guestId);
  if (!guest || !guestMay(guest, 'links')) return false;
  if (claim.action === 'attach') {
    if (!claim.url) return false;
    useInputStore.getState().setPendingGuestIssue(clampAttachRequest({ providerId: guest.id, id: claim.identifier, title: claim.identifier, url: claim.url }));
    return true;
  }
  const item = claim.url ? { kind: 'link' as const, identifier: claim.identifier, url: claim.url } : { kind: 'link' as const, identifier: claim.identifier };
  if (openGuestWithItem(guest, item, directory)) return true;
  if (clicked === 'link') return false;
  toast.info(t('chat.guestLink.noProject', { name: guest.name }));
  return true;
};
