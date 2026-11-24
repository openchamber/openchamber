import { createHash, randomBytes } from 'node:crypto';
import { isPluginTag, OPEN_PUSH_TAGS_LIMIT, type createPushTags } from './push-tags.js';
import type { createPushFanout } from './push-fanout.js';

export interface PluginNotice {
  title: string;
  body?: string | undefined;
  tag?: string | undefined;
  sessionId?: string | undefined;
}

const PLUGIN_PUSH_CLAIMS_PER_SESSION = 10;
const PLUGIN_PUSH_CLAIMS_TOTAL = 100;

interface PluginPushDependencies {
  pushTags: ReturnType<typeof createPushTags>;
  fanoutPush: ReturnType<typeof createPushFanout>;
  isPushSuppressed: () => Promise<boolean>;
  readSessionSummary: (sessionId: string) => Promise<{ found: boolean; name: string }>;
  phoneBodyOf: (title: string, body: string) => string;
  buildSessionDeepLinkUrl: (sessionId: string | undefined) => string;
}

export const createPluginPush = ({
  pushTags, fanoutPush, isPushSuppressed, readSessionSummary, phoneBodyOf, buildSessionDeepLinkUrl,
}: PluginPushDependencies) => {
  const latestArrival = new Map<string, number>();
  let arrivals = 0;

  const trimClaimsToFit = (sessionId: string, keepTag: string, room: number) => {
    const plugin = [...pushTags.open].filter(([key]) => key !== keepTag && isPluginTag(key));
    const own = plugin.filter(([, open]) => open.sessionId === sessionId);
    const drop = new Set([
      ...own.slice(0, Math.max(0, own.length - PLUGIN_PUSH_CLAIMS_PER_SESSION + room)),
      ...plugin.slice(0, Math.max(0, plugin.length - PLUGIN_PUSH_CLAIMS_TOTAL + room)),
    ].map(([key]) => key));
    const remaining = plugin.filter(([key]) => !drop.has(key));
    const overflow = pushTags.open.size - drop.size + room - OPEN_PUSH_TAGS_LIMIT;
    for (const [key] of remaining.slice(0, Math.max(0, overflow))) drop.add(key);
    if (drop.size > 0) {
      for (const key of drop) pushTags.open.delete(key);
      pushTags.persist();
    }
    return pushTags.open.size + room <= OPEN_PUSH_TAGS_LIMIT;
  };

  const claimIfRoom = (pushTag: string, sessionId: string) => {
    if (!trimClaimsToFit(sessionId, pushTag, pushTags.open.has(pushTag) ? 0 : 1)) return undefined;
    return pushTags.claimRestoredTag(pushTag, { sessionId });
  };

  return async ({ title, body = '', tag, sessionId: requestedSessionId }: PluginNotice) => {
    if (await isPushSuppressed()) return;
    const pushTag = `plugin-${tag ? createHash('sha256').update(tag).digest('hex').slice(0, 16) : randomBytes(8).toString('hex')}`;
    const arrival = ++arrivals;
    latestArrival.set(pushTag, arrival);
    const session = requestedSessionId ? await readSessionSummary(requestedSessionId) : null;
    await pushTags.restored;
    if (latestArrival.get(pushTag) !== arrival) return;
    latestArrival.delete(pushTag);
    const verifiedSessionId = session?.found ? requestedSessionId : undefined;
    const claim = verifiedSessionId ? claimIfRoom(pushTag, verifiedSessionId) : undefined;
    if (!claim) pushTags.detach(pushTag);
    const sent = fanoutPush({
      title,
      body,
      phoneBody: phoneBodyOf(title, body) || title,
      claim,
      tag: pushTag,
      data: {
        url: buildSessionDeepLinkUrl(verifiedSessionId),
        sessionId: verifiedSessionId,
        sessionName: session?.found ? session.name : '',
        type: 'plugin',
        nid: claim ? undefined : pushTags.nextNotificationId(),
      },
    }, { requireNoSse: true });
    if (claim && verifiedSessionId) trimClaimsToFit(verifiedSessionId, '', 0);
    await sent;
  };
};
