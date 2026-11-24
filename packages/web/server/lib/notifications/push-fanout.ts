import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle } from './message.js';
import { hasErrorMessage } from './inputs.js';
import type { JsonValue } from './contracts.js';
import type { createApnsRuntime } from './apns-runtime.js';
import type { ExtensionNotificationDelivery } from './extension-channels.js';
import type { createPushRuntime } from './push-runtime.js';
import type { createPushTags, PushClaim } from './push-tags.js';

export type NotificationKind = ExtensionNotificationDelivery['notification']['kind'];
export type PushOptions = Parameters<ReturnType<typeof createPushRuntime>['sendPushToAllUiSessions']>[1];

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

interface PushFanoutDependencies {
  pushTags: ReturnType<typeof createPushTags>;
  isAnyInteractiveClientVisible?: (() => boolean) | undefined;
  sendPushToAllUiSessions?: ((payload: TriggerPushPayload, options: PushOptions) => PromiseLike<void> | void) | undefined;
  sendApnsToAllUiSessions?: ReturnType<typeof createApnsRuntime>['sendApnsToAllUiSessions'] | undefined;
}

const genericTitleOf = (payload: TriggerPushPayload) => genericNotificationTitle(payload.data.type);

export const createPushFanout = ({
  pushTags, isAnyInteractiveClientVisible, sendPushToAllUiSessions, sendApnsToAllUiSessions,
}: PushFanoutDependencies) => {
  const toApnsGenericPayload = (payload: TriggerPushPayload & { phoneBody: string; nid: JsonValue | undefined }) => {
    const data = payload.data;
    const knownSessionName = data.sessionName?.trim() ?? '';
    const sessionName = knownSessionName || (data.type === 'pull-request' || (data.type === 'plugin' && !data.sessionId) ? '' : 'Session');
    const phoneBody = payload?.phoneBody ?? '';
    return {
      title: genericTitleOf(payload),
      body: isEnterpriseMode() ? '' : sessionName,
      sealed: phoneBody && !isEnterpriseMode()
        ? { title: knownSessionName || genericTitleOf(payload), body: phoneBody }
        : undefined,
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

  const toWebPushPayload = (payload: TriggerPushPayload) => {
    if (!isEnterpriseMode()) return payload;
    const { sessionName: _sessionName, ...rest } = payload.data ?? {};
    return { ...payload, title: genericTitleOf(payload), body: '', data: rest };
  };

  return ({ phoneBody, claim, ...pushPayload }: TriggerPushPayload & { phoneBody: string; claim?: PushClaim | undefined }, options: PushOptions) => {
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
