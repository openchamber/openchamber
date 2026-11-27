import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle } from './message.js';
import { hasErrorMessage } from './inputs.js';
import type { JsonValue } from './contracts.js';
import type { createApnsRuntime } from './apns-runtime.js';
import type { ExtensionNotificationDelivery } from './extension-channels.js';
import type { createPushRuntime } from './push-runtime.js';
import type { createPushTags, PushClaim } from './push-tags.js';
import type { PushContent } from './push-seal.js';

export type NotificationKind = ExtensionNotificationDelivery['notification']['kind'];
export type PushOptions = Parameters<ReturnType<typeof createPushRuntime>['sendPushToAllUiSessions']>[1];

export interface PushItemTarget {
  url: string;
  directory?: string | undefined;
}

export interface TriggerPushPayload {
  title: string;
  body: string;
  tag: string;
  clear?: JsonValue[];
  data: {
    url: string;
    type: NotificationKind | 'plugin';
    sessionId?: string | undefined;
    sessionName?: string;
    nid?: JsonValue | undefined;
  };
}

export const itemWebRoute = ({ url, directory }: PushItemTarget) => {
  const params = new URLSearchParams({ item: url });
  if (directory) params.set('itemDir', directory);
  return `/?${params.toString()}`;
};

export const itemPhoneLink = ({ url, directory }: PushItemTarget) => {
  const params = new URLSearchParams({ url });
  if (directory) params.set('dir', directory);
  return `openchamber://tracker-item?${params.toString()}`;
};

interface PushFanoutDependencies {
  pushTags: ReturnType<typeof createPushTags>;
  isAnyInteractiveClientVisible?: (() => boolean) | undefined;
  sendPushToAllUiSessions?: ((payload: TriggerPushPayload, options: PushOptions) => PromiseLike<void> | void) | undefined;
  sendApnsToAllUiSessions?: ReturnType<typeof createApnsRuntime>['sendApnsToAllUiSessions'] | undefined;
}

type FanoutPayload = TriggerPushPayload & { phoneBody: string; item?: PushItemTarget | undefined };

const genericTitleOf = (payload: TriggerPushPayload) => genericNotificationTitle(payload.data.type);

const sealedContentOf = (payload: FanoutPayload, title: string): PushContent => {
  const sealed: PushContent = { title, body: payload.phoneBody };
  if (payload.item) sealed.url = itemPhoneLink(payload.item);
  return sealed;
};

export const createPushFanout = ({
  pushTags, isAnyInteractiveClientVisible, sendPushToAllUiSessions, sendApnsToAllUiSessions,
}: PushFanoutDependencies) => {
  const toApnsGenericPayload = (payload: FanoutPayload & { nid: JsonValue | undefined }) => {
    const data = payload.data;
    const knownSessionName = data.sessionName?.trim() ?? '';
    const sessionName = knownSessionName || (data.type === 'pull-request' || (data.type === 'plugin' && !data.sessionId) ? '' : 'Session');
    const phoneBody = payload?.phoneBody ?? '';
    return {
      title: genericTitleOf(payload),
      body: isEnterpriseMode() ? '' : sessionName,
      sealed: phoneBody && !isEnterpriseMode() ? sealedContentOf(payload, knownSessionName || genericTitleOf(payload)) : undefined,
      badge: pushTags.countBadge(payload.tag),
      tag: payload?.tag,
      data: {
        sessionId: data.sessionId,
        tag: payload?.tag,
        nid: payload?.nid,
        clear: payload?.clear?.join(','),
      },
    };
  };

  const toWebPushPayload = ({ item, ...payload }: TriggerPushPayload & { item?: PushItemTarget | undefined }): TriggerPushPayload => {
    if (!isEnterpriseMode()) return item ? { ...payload, data: { ...payload.data, url: itemWebRoute(item) } } : payload;
    const { sessionName: _sessionName, ...rest } = payload.data ?? {};
    return { ...payload, title: genericTitleOf(payload), body: '', data: rest };
  };

  return ({ phoneBody, claim, ...pushPayload }: FanoutPayload & { claim?: PushClaim | undefined }, options: PushOptions) => {
    const tag = pushPayload.tag ?? '';
    if (claim && !pushTags.isCurrent(tag, claim)) return Promise.resolve();
    const interactiveVisible = isAnyInteractiveClientVisible?.() === true;
    const clear = pushTags.clearEntriesForPush(tag, !interactiveVisible);
    const payload = clear.length > 0 ? { ...pushPayload, clear } : pushPayload;
    if (claim) pushTags.recordDelivery(claim, !interactiveVisible);
    return Promise.all([
      Promise.resolve(sendPushToAllUiSessions?.(toWebPushPayload(claim ? { ...payload, data: { ...payload.data, nid: claim.nid } } : payload), options)).catch((error) => {
        console.warn('[Push] web-push fanout failed:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
      }),
      interactiveVisible
        ? Promise.resolve()
        : Promise.resolve(sendApnsToAllUiSessions?.(toApnsGenericPayload({ ...payload, phoneBody, nid: claim?.nid ?? payload.data.nid }), options)).catch((error) => {
            console.warn('[APNs] fanout failed:', (hasErrorMessage(error) ? error.message : undefined) ?? error);
          }),
    ]);
  };
};
