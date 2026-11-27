import { z } from 'zod';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

import { getClientPlatform } from '@/lib/platform';
import { captureRuntimeInstance } from '@/lib/runtime-switch';

const sessionIdentitySchema = z.object({ sessionId: z.string().min(1), serverId: z.string().min(1) });

const sessionBannerDataSchema = z.union([
  sessionIdentitySchema
    .extend({ 'openchamber.nid': z.string().min(1) })
    .transform(({ sessionId, serverId, 'openchamber.nid': nid }) => ({ sessionId, serverId, nid })),
  sessionIdentitySchema.extend({ nid: z.string().min(1) }),
]);

type DeliveredBanner = Pick<PushNotificationSchema, 'id' | 'tag' | 'data'>;

type SeenBanner = { tag?: string; id: DeliveredBanner['id']; nid: string };

type NativeBanners = {
  list: () => Promise<DeliveredBanner[]>;
  remove: (banners: SeenBanner[]) => Promise<void>;
  activeServerId: () => string | null;
};

type PushBannersPlugin = {
  remove: (options: { banners: SeenBanner[] }) => Promise<void>;
  list: () => Promise<{ notifications: DeliveredBanner[] }>;
};

let nativeBanners: Promise<NativeBanners> | null = null;

const readNativeBanners = async (): Promise<NativeBanners> => {
  const { registerPlugin } = await import('@capacitor/core');
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const { activePushServerId } = await import('@/apps/mobilePushIdentity');
  const PushBanners = registerPlugin<PushBannersPlugin>('PushBanners');
  const listDelivered = getClientPlatform() === 'ios'
    ? () => PushBanners.list()
    : () => PushNotifications.getDeliveredNotifications();
  return {
    list: async () => (await listDelivered()).notifications,
    remove: (banners) => PushBanners.remove({ banners }),
    activeServerId: activePushServerId,
  };
};

const loadNativeBanners = (): Promise<NativeBanners> => {
  nativeBanners ??= readNativeBanners();
  return nativeBanners;
};

export const nativeSessionBannersAvailable = (): boolean => {
  const platform = getClientPlatform();
  return platform === 'android' || platform === 'ios';
};

const seenBannersOf = async (
  sessionIds: readonly string[],
  banners: NativeBanners,
  isCurrent: () => boolean,
): Promise<SeenBanner[]> => {
  if (!isCurrent()) return [];
  const serverId = banners.activeServerId();
  if (!serverId || sessionIds.length === 0) return [];
  const wanted = new Set(sessionIds);
  return (await banners.list()).flatMap((banner) => {
    const data = sessionBannerDataSchema.safeParse(banner.data).data;
    if (!data || data.serverId !== serverId || !wanted.has(data.sessionId)) return [];
    return [{ tag: banner.tag, id: banner.id, nid: data.nid }];
  });
};

export const hasNativeSessionNotifications = async (
  sessionIds: readonly string[],
  load: () => Promise<NativeBanners> = loadNativeBanners,
): Promise<boolean> => {
  const isCurrent = captureRuntimeInstance();
  try {
    return (await seenBannersOf(sessionIds, await load(), isCurrent)).length > 0;
  } catch {
    return false;
  }
};

export const clearNativeSessionNotifications = async (
  sessionIds: readonly string[],
  load: () => Promise<NativeBanners> = loadNativeBanners,
): Promise<void> => {
  const isCurrent = captureRuntimeInstance();
  try {
    const banners = await load();
    const seen = await seenBannersOf(sessionIds, banners, isCurrent);
    if (seen.length > 0) await banners.remove(seen);
  } catch {
    return;
  }
};
