import { clampAttachRequest, resolveAttachMode } from '@openchamber/sdk';

import { toast } from '@/components/ui';
import { guestMay } from '@/lib/guests/capabilities';
import { openGuestWithItem } from '@/lib/guests/dialog-store';
import { isGuestInFolders, useGuestScopeStore } from '@/lib/guests/folders';
import type { GuestLinkClaim } from '@/lib/guests/links';
import { guestPanelOpensHere } from '@/lib/guests/phone';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isMiniChatWindow } from '@/lib/miniChatWindow';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { commitShaOfUrl } from '@/lib/source-control/repositoryLinks';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { useInputStore } from '@/sync/input-store';

export const isBuiltInLink = (url: string): boolean => {
  const descriptors = useSourceControlProviderRegistry.getState().ordered;
  if (createTrackerUrlMatcher(useTrackerRegistry.getState().ordered)(url)) return true;
  if (createRepositoryUrlMatcher(descriptors, useSourceControlAuthStore.getState().identities).match(url)) return true;
  return commitShaOfUrl(url, descriptors) !== null;
};

export const guestPanelHiddenHere = (
  guest: InstalledGuest,
  scopePaths: readonly string[],
): 'mini-chat' | 'other-project' | null => {
  if (resolveAttachMode(guest.attach) === 'dialog') return null;
  if (isMiniChatWindow()) return 'mini-chat';
  return isGuestInFolders(guest, scopePaths) ? null : 'other-project';
};

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
  if (!guestPanelOpensHere(guest)) {
    if (clicked === 'link') return false;
    toast.info(t('chat.chatInput.toast.guestNotOnPhone', { name: guest.name }));
    return true;
  }
  const hidden = guestPanelHiddenHere(guest, useGuestScopeStore.getState().paths);
  if (hidden) {
    if (clicked === 'link') return false;
    toast.info(t(hidden === 'mini-chat' ? 'chat.guestLink.miniChat' : 'chat.guestLink.otherProject', { name: guest.name }));
    return true;
  }
  const item = claim.url ? { kind: 'link' as const, identifier: claim.identifier, url: claim.url } : { kind: 'link' as const, identifier: claim.identifier };
  if (openGuestWithItem(guest, item, directory)) return true;
  if (clicked === 'link') return false;
  toast.info(t('chat.guestLink.noProject', { name: guest.name }));
  return true;
};
