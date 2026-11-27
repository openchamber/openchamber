import { createHash } from 'node:crypto';
import { pullRequestNotificationTitle } from './pull-request-locales.js';
import type { JsonValue, NotificationPayload } from './contracts.js';
import type { createPushFanout, PushItemTarget } from './push-fanout.js';

export interface PullRequestNotice {
  item: { instance?: string | undefined; owner: string; repo: string; number: number };
  event: Parameters<typeof pullRequestNotificationTitle>[1];
  url?: string | undefined;
  directory?: string | null | undefined;
}

interface PullRequestSettings {
  locale?: JsonValue | undefined;
  notificationMode?: JsonValue | undefined;
  nativeNotificationsEnabled?: JsonValue | undefined;
  notifyOnPullRequests?: JsonValue | undefined;
}

interface PullRequestNoticeDependencies<Settings extends PullRequestSettings> {
  readSettings: () => Promise<Settings>;
  isWindowFocused: () => boolean;
  showInOpenClients: (payload: NotificationPayload) => void;
  fanoutPush: ReturnType<typeof createPushFanout>;
  sendToChannels: (notice: { kind: 'pull-request'; title: string; body: string; tag: string }, settings: Settings) => void;
}

export const createPullRequestNotifier = <Settings extends PullRequestSettings>({
  readSettings, isWindowFocused, showInOpenClients, fanoutPush, sendToChannels,
}: PullRequestNoticeDependencies<Settings>) => async ({ item, event, url, directory }: PullRequestNotice) => {
  const settings = await readSettings();
  if (settings.notifyOnPullRequests === false) return;
  if (settings.notificationMode !== 'always' && isWindowFocused()) return;
  const title = pullRequestNotificationTitle(String(settings.locale), event);
  if (!title) return;
  const body = `${item.owner}/${item.repo}#${item.number}`;
  const tag = `pull-request-${createHash('sha256').update(`${item.instance}\n${body}`).digest('hex').slice(0, 16)}-${event}`;
  const payload: NotificationPayload = { title, body, tag, kind: 'pull-request', requireHidden: settings.notificationMode !== 'always' };
  let target: PushItemTarget | undefined;
  if (url) {
    target = { url };
    payload.itemUrl = url;
    if (directory) {
      target.directory = directory;
      payload.directory = directory;
    }
  }
  if (settings.nativeNotificationsEnabled) {
    showInOpenClients(payload);
  }
  await fanoutPush({ title, body, phoneBody: `${title}: ${body}`, tag, item: target, data: { url: '/', type: 'pull-request' } }, { requireNoSse: true });
  sendToChannels({ kind: 'pull-request', title, body, tag }, settings);
};
