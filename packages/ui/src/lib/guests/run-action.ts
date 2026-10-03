import { GUEST_REQUEST_TIMEOUT_MS, OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL, type ActionResultPayload, type GuestActionItem, type HostActionMessage } from '@openchamber/sdk';
import { toast } from 'sonner';
import { create } from 'zustand';

import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { GuestActionEntry } from './actions.ts';
import { isGuestActive } from './capabilities.ts';
import { openGuestWithItem } from './dialog-store.ts';
import { useGuestsStore } from './store.ts';

type ActionOutcome = ActionResultPayload | { ok: false; reason: 'timeout' | 'unavailable' };

/** One click owns one temporary frame and one completion, independently of other clicks. */
export type GuestBackgroundAction = {
  id: string;
  guestId: string;
  item: GuestActionItem;
  isActive: () => boolean;
  takeMessage: () => HostActionMessage | null;
  complete: (outcome: ActionOutcome) => void;
};

export const useGuestActionHostStore = create<{ requests: GuestBackgroundAction[] }>(() => ({ requests: [] }));

const isCurrentAction = (entry: GuestActionEntry, item: GuestActionItem, runtimeKey: string): boolean => {
  const catalog = useGuestsStore.getState();
  if (isVSCodeRuntime() || isMobileSurfaceRuntime() || getRuntimeKey() !== runtimeKey || catalog.runtimeKey !== runtimeKey) return false;
  const guest = catalog.guests.find((candidate) => candidate.id === entry.guest.id);
  if (!guest || (!guest.entry && !guest.backgroundEntry) || !isGuestActive(guest)
    || guest.version !== entry.guest.version || guest.entry !== entry.guest.entry || guest.backgroundEntry !== entry.guest.backgroundEntry) return false;
  const action = guest.actions?.find((candidate) => candidate.id === item.action);
  if (!action || action.where !== item.kind || JSON.stringify(action) !== JSON.stringify(entry.action)) return false;
  if (action.mode !== 'background' && !guest.entry) return false;
  if (item.kind === 'message') return !action.roles || action.roles.includes(item.role);
  return !item.messages || (action.payload?.includes('messages') === true && guest.capabilities.granted.includes('conversation'));
};

const runBackgroundAction = (entry: GuestActionEntry, item: GuestActionItem, runtimeKey: string): Promise<ActionOutcome> => {
  // Bound hidden documents even when repeated clicks arrive before a frame can answer.
  if (useGuestActionHostStore.getState().requests.length >= 8) return Promise.resolve({ ok: false, reason: 'unavailable' });
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let active = true;
    let sent = false;
    const isActive = () => active && isCurrentAction(entry, item, runtimeKey);
    const complete = (outcome: ActionOutcome) => {
      if (!active) return;
      const authorized = isActive();
      active = false;
      clearTimeout(timer);
      unsubscribeRuntime();
      unsubscribeCatalog();
      useGuestActionHostStore.setState((state) => ({ requests: state.requests.filter((request) => request.id !== id) }));
      resolve(authorized ? outcome : { ok: false, reason: 'unavailable' });
    };
    const timer = setTimeout(() => complete({ ok: false, reason: 'timeout' }), GUEST_REQUEST_TIMEOUT_MS);
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => complete({ ok: false, reason: 'unavailable' }));
    const unsubscribeCatalog = useGuestsStore.subscribe(() => {
      if (!isActive()) complete({ ok: false, reason: 'unavailable' });
    });
    const request: GuestBackgroundAction = {
      id, guestId: entry.guest.id, item, isActive, complete,
      takeMessage: () => {
        if (sent || !isActive()) return null;
        sent = true;
        return { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'action', id, payload: item };
      },
    };
    useGuestActionHostStore.setState((state) => ({ requests: [...state.requests, request] }));
  });
};

/** Revalidate the menu's captured declaration before opening UI or starting guest code. */
export const runGuestAction = async (
  entry: GuestActionEntry,
  item: GuestActionItem,
  t: (key: I18nKey, params?: I18nParams) => string,
  runtimeKey = getRuntimeKey(),
): Promise<void> => {
  if (!isCurrentAction(entry, item, runtimeKey)) return;
  if (entry.action.mode !== 'background') {
    openGuestWithItem(entry.guest, item, item.directory);
    return;
  }
  const outcome = await runBackgroundAction(entry, structuredClone(item), runtimeKey);
  if (outcome.ok || getRuntimeKey() !== runtimeKey) return;
  toast.error(t('contextPanel.plugin.actionFailed', { name: entry.guest.name, action: entry.action.label }), {
    description: 'error' in outcome ? outcome.error : t('chat.chatInput.toast.guestCommandUnavailable', { name: entry.guest.name }),
  });
};
