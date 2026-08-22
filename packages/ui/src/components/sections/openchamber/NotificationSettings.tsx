import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getClientPlatform } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  SettingsSection,
  SettingsTwoColumn,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsGroupTitle,
  SettingsStackedField,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: {
    titleKey: 'settings.notifications.page.template.defaults.completion.title',
    messageKey: 'settings.notifications.page.template.defaults.completion.message',
  },
  error: {
    titleKey: 'settings.notifications.page.template.defaults.error.title',
    messageKey: 'settings.notifications.page.template.defaults.error.message',
  },
  question: {
    titleKey: 'settings.notifications.page.template.defaults.question.title',
    messageKey: 'settings.notifications.page.template.defaults.question.message',
  },
  subtask: {
    titleKey: 'settings.notifications.page.template.defaults.subtask.title',
    messageKey: 'settings.notifications.page.template.defaults.subtask.message',
  },
} as const;
type NotificationTemplateEvent = keyof typeof DEFAULT_NOTIFICATION_TEMPLATES;
const TEMPLATE_EVENT_LABEL_KEYS = {
  completion: 'settings.notifications.page.template.event.completion',
  subtask: 'settings.notifications.page.template.event.subtask',
  error: 'settings.notifications.page.template.event.error',
  question: 'settings.notifications.page.template.event.question',
} as const satisfies Record<NotificationTemplateEvent, string>;

type MessengerProviderId = 'slack' | 'discord';

interface MessengerProviderState {
  enabled: boolean;
  webhookConfigured: boolean;
}

type MessengerSettingsState = Record<MessengerProviderId, MessengerProviderState>;

// Provider display names are product names (not translated); example URLs are
// literal endpoint formats, also exempt from translation.
const MESSENGER_PROVIDERS: ReadonlyArray<{
  id: MessengerProviderId;
  name: string;
  urlPlaceholder: string;
}> = [
  { id: 'slack', name: 'Slack', urlPlaceholder: 'https://hooks.slack.com/services/...' },
  { id: 'discord', name: 'Discord', urlPlaceholder: 'https://discord.com/api/webhooks/...' },
];

const parseMessengerSettings = (data: unknown): MessengerSettingsState | null => {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Record<string, unknown>;
  const parseEntry = (value: unknown): MessengerProviderState | null => {
    if (!value || typeof value !== 'object') return null;
    const entry = value as Record<string, unknown>;
    return {
      enabled: entry.enabled === true,
      webhookConfigured: entry.webhookConfigured === true,
    };
  };
  const slack = parseEntry(candidate.slack);
  const discord = parseEntry(candidate.discord);
  if (!slack || !discord) return null;
  return { slack, discord };
};

export const NotificationSettings: React.FC = () => {
  const { t } = useI18n();
  const isDesktop = React.useMemo(() => isDesktopShell(), []);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  // The native Capacitor app runs in a WKWebView with no Web Notification API; it has its
  // own native (Local Notifications) permission. Treat it as a native runtime, not a
  // browser, so the toggle isn't gated on Notification.permission (which is stuck there).
  const isNativeApp = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
  }, []);
  const isBrowser = !isDesktop && !isVSCode && !isNativeApp;
  const nativeNotificationsEnabled = useUIStore(state => state.nativeNotificationsEnabled);
  const setNativeNotificationsEnabled = useUIStore(state => state.setNativeNotificationsEnabled);
  const notificationMode = useUIStore(state => state.notificationMode);
  const setNotificationMode = useUIStore(state => state.setNotificationMode);
  const notifyOnSubtasks = useUIStore(state => state.notifyOnSubtasks);
  const setNotifyOnSubtasks = useUIStore(state => state.setNotifyOnSubtasks);
  const notifyOnCompletion = useUIStore(state => state.notifyOnCompletion);
  const setNotifyOnCompletion = useUIStore(state => state.setNotifyOnCompletion);
  const notifyOnError = useUIStore(state => state.notifyOnError);
  const setNotifyOnError = useUIStore(state => state.setNotifyOnError);
  const notifyOnQuestion = useUIStore(state => state.notifyOnQuestion);
  const setNotifyOnQuestion = useUIStore(state => state.setNotifyOnQuestion);
  const notificationTemplates = useUIStore(state => state.notificationTemplates);
  const setNotificationTemplates = useUIStore(state => state.setNotificationTemplates);

  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission>('default');
  const [pushSupported, setPushSupported] = React.useState(false);
  const [pushSubscribed, setPushSubscribed] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);

  // Messenger (Slack/Discord) webhook settings live on the server only —
  // webhook URLs are write-only secrets, so the client sees just
  // enabled + webhookConfigured flags. `null` means "not loaded yet";
  // a failed load renders an explicit error instead of empty defaults.
  const [messengerSettings, setMessengerSettings] = React.useState<MessengerSettingsState | null>(null);
  const [messengerLoadFailed, setMessengerLoadFailed] = React.useState(false);
  const [messengerInputs, setMessengerInputs] = React.useState<Record<MessengerProviderId, string>>({
    slack: '',
    discord: '',
  });
  const [messengerBusy, setMessengerBusy] = React.useState<MessengerProviderId | null>(null);

  const loadMessengerSettings = React.useCallback(async (): Promise<void> => {
    try {
      const response = await runtimeFetch('/api/notifications/messengers', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Messenger settings request failed (${response.status})`);
      }
      const parsed = parseMessengerSettings(await response.json().catch(() => null));
      if (!parsed) {
        throw new Error('Messenger settings response malformed');
      }
      setMessengerSettings(parsed);
      setMessengerLoadFailed(false);
    } catch (error) {
      console.warn('Failed to load messenger settings:', error);
      setMessengerLoadFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void loadMessengerSettings();
  }, [loadMessengerSettings]);

  const putMessengerUpdate = async (
    update: Partial<Record<MessengerProviderId, { enabled?: boolean; webhookUrl?: string | null }>>,
  ): Promise<{ ok: boolean; code?: string }> => {
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/notifications/messengers', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(update),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { code?: string } | null;
        reportSettingsSaveState('error');
        return { ok: false, code: typeof data?.code === 'string' ? data.code : undefined };
      }
      const parsed = parseMessengerSettings(await response.json().catch(() => null));
      if (parsed) {
        setMessengerSettings(parsed);
      }
      reportSettingsSaveState('saved');
      return { ok: true };
    } catch (error) {
      console.warn('Failed to update messenger settings:', error);
      reportSettingsSaveState('error');
      return { ok: false };
    }
  };

  const handleMessengerToggle = async (provider: MessengerProviderId, enabled: boolean) => {
    setMessengerBusy(provider);
    try {
      const result = await putMessengerUpdate({ [provider]: { enabled } });
      if (!result.ok) {
        toast.error(t('settings.notifications.page.messengers.toast.saveFailed'));
      }
    } finally {
      setMessengerBusy(null);
    }
  };

  const handleMessengerSaveWebhook = async (provider: MessengerProviderId, providerName: string) => {
    const webhookUrl = messengerInputs[provider].trim();
    if (!webhookUrl) return;
    setMessengerBusy(provider);
    try {
      const result = await putMessengerUpdate({ [provider]: { webhookUrl } });
      if (result.ok) {
        setMessengerInputs((current) => ({ ...current, [provider]: '' }));
      } else if (result.code === 'invalid-webhook-url') {
        toast.error(t('settings.notifications.page.messengers.toast.invalidUrl', { messenger: providerName }));
      } else {
        toast.error(t('settings.notifications.page.messengers.toast.saveFailed'));
      }
    } finally {
      setMessengerBusy(null);
    }
  };

  const handleMessengerRemoveWebhook = async (provider: MessengerProviderId) => {
    setMessengerBusy(provider);
    try {
      const result = await putMessengerUpdate({ [provider]: { webhookUrl: null } });
      if (!result.ok) {
        toast.error(t('settings.notifications.page.messengers.toast.saveFailed'));
      }
    } finally {
      setMessengerBusy(null);
    }
  };

  const handleMessengerTest = async (provider: MessengerProviderId, providerName: string) => {
    const pendingUrl = messengerInputs[provider].trim();
    setMessengerBusy(provider);
    try {
      const response = await runtimeFetch('/api/notifications/messengers/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(pendingUrl ? { provider, webhookUrl: pendingUrl } : { provider }),
      });
      if (response.ok) {
        toast.success(t('settings.notifications.page.messengers.toast.testSent', { messenger: providerName }));
      } else {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        if (data?.error === 'invalid-webhook-url') {
          toast.error(t('settings.notifications.page.messengers.toast.invalidUrl', { messenger: providerName }));
        } else {
          toast.error(t('settings.notifications.page.messengers.toast.testFailed', { messenger: providerName }));
        }
      }
    } catch (error) {
      console.warn('Messenger test failed:', error);
      toast.error(t('settings.notifications.page.messengers.toast.testFailed', { messenger: providerName }));
    } finally {
      setMessengerBusy(null);
    }
  };

  React.useEffect(() => {
    if (!isBrowser) {
      setPushSupported(false);
      setPushSubscribed(false);
      return;
    }

    if (typeof Notification !== 'undefined') {
      setNotificationPermission(Notification.permission);
    }

    const supported = typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
    setPushSupported(supported);

    const refresh = async () => {
      if (!supported) {
        setPushSubscribed(false);
        return;
      }

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) {
          setPushSubscribed(false);
          return;
        }
        const subscription = await registration.pushManager.getSubscription();
        setPushSubscribed(Boolean(subscription));
      } catch {
        setPushSubscribed(false);
      }
    };

    void refresh();
  }, [isBrowser]);

  const handleToggleChange = async (checked: boolean) => {
    if (isDesktop) {
      setNativeNotificationsEnabled(checked);
      return;
    }

    if (!isBrowser) {
      setNativeNotificationsEnabled(checked);
      return;
    }
    if (checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission();
        setNotificationPermission(permission);
        if (permission === 'granted') {
          setNativeNotificationsEnabled(true);
        } else {
          toast.error(t('settings.notifications.page.toast.permissionDenied.title'), {
            description: t('settings.notifications.page.toast.permissionDenied.description'),
          });
        }
      } catch (error) {
        console.error('Failed to request notification permission:', error);
        toast.error(t('settings.notifications.page.toast.requestPermissionFailed'));
      }
    } else if (checked && notificationPermission === 'granted') {
      setNativeNotificationsEnabled(true);
    } else {
      setNativeNotificationsEnabled(false);
    }
  };

  const canShowNotifications = isDesktop || isVSCode || isNativeApp || (isBrowser && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  const updateTemplate = (
    event: 'completion' | 'error' | 'question' | 'subtask',
    field: 'title' | 'message',
    value: string,
  ) => {
    setNotificationTemplates((current) => ({
      ...current,
      [event]: {
        ...current[event],
        [field]: value,
      },
    }));
  };

  const base64UrlToUint8Array = (base64Url: string): Uint8Array<ArrayBuffer> => {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
    for (let i = 0; i < raw.length; i += 1) {
      output[i] = raw.charCodeAt(i);
    }
    return output;
  };

  const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(label));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const waitForSwActive = async (registration: ServiceWorkerRegistration): Promise<void> => {
    if (registration.active) {
      return;
    }

    const candidate = registration.installing || registration.waiting;
    if (!candidate) {
      return;
    }

    if (candidate.state === 'activated') {
      return;
    }

    await withTimeout(
      new Promise<void>((resolve) => {
        const onStateChange = () => {
          if (candidate.state === 'activated') {
            candidate.removeEventListener('statechange', onStateChange);
            resolve();
          }
        };

        candidate.addEventListener('statechange', onStateChange);
        onStateChange();
      }),
      15000,
      'Service worker activation timed out'
    );
  };

  type RegistrationOptions = {
    scope?: string;
    type?: 'classic' | 'module';
    updateViaCache?: 'imports' | 'all' | 'none';
  };

  const registerServiceWorker = async (): Promise<ServiceWorkerRegistration> => {
    if (typeof navigator.serviceWorker.register !== 'function') {
      throw new Error('navigator.serviceWorker.register unavailable');
    }

    const attempts: Array<{ label: string; opts: RegistrationOptions | null }> = [
      { label: 'no-options', opts: null },
      { label: 'scope-root', opts: { scope: '/' } },
      { label: 'type-classic', opts: { type: 'classic' } },
      { label: 'type-classic-scope', opts: { type: 'classic', scope: '/' } },
      { label: 'updateViaCache-none', opts: { type: 'classic', updateViaCache: 'none', scope: '/' } },
    ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        const promise = attempt.opts
          ? navigator.serviceWorker.register('/sw.js', attempt.opts)
          : navigator.serviceWorker.register('/sw.js');

        return await withTimeout(promise, 10000, `Service worker registration timed out (${attempt.label})`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Service worker registration failed');
  };

  const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration> => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service worker not supported');
    }

    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) {
      return existing;
    }

    const registered = await registerServiceWorker();

    try {
      await registered.update();
    } catch {
      // ignore
    }

    await waitForSwActive(registered);
    return registered;
  };

  const formatUnknownError = (error: unknown) => {
    const anyError = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const parts = [
      `type=${typeof error}`,
      `toString=${String(error)}`,
      `name=${String(anyError?.name ?? '')}`,
      `message=${String(anyError?.message ?? '')}`,
    ];

    let json = '';
    try {
      json = JSON.stringify(error);
    } catch {
      // ignore
    }

    return {
      summary: parts.filter(Boolean).join(' | '),
      json,
      stack: typeof anyError?.stack === 'string' ? anyError.stack : '',
    };
  };

  const handleTestNotification = async () => {
    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.notifications) {
      toast.error(t('settings.notifications.page.toast.notificationsApiUnavailable'));
      return;
    }

    try {
      const success = await apis.notifications.notifyAgentCompletion({
        title: t('settings.notifications.page.testNotification.title'),
        body: t('settings.notifications.page.testNotification.body'),
        tag: 'openchamber-test',
      });

      if (success) {
        toast.success(t('settings.notifications.page.toast.testNotificationSent'));
      } else {
        toast.error(t('settings.notifications.page.toast.testNotificationFailed'));
      }
    } catch (error) {
      console.error('Test notification failed:', error);
      toast.error(t('settings.notifications.page.toast.testNotificationFailed'));
    }
  };

  const handleEnableBackgroundNotifications = async () => {
    if (!pushSupported) {
      toast.error(t('settings.notifications.page.toast.pushUnsupported'));
      return;
    }

    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.push) {
      toast.error(t('settings.notifications.page.toast.pushApiUnavailable'));
      return;
    }

    setPushBusy(true);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        setNotificationPermission(permission);
        if (permission !== 'granted') {
          toast.error(t('settings.notifications.page.toast.permissionDenied.title'), {
            description: t('settings.notifications.page.toast.permissionDenied.enableInBrowser'),
          });
          return;
        }
      }

      if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        toast.error(t('settings.notifications.page.toast.permissionDenied.title'), {
          description: t('settings.notifications.page.toast.permissionDenied.enableInBrowser'),
        });
        return;
      }

      const key = await apis.push.getVapidPublicKey();
      if (!key?.publicKey) {
        toast.error(t('settings.notifications.page.toast.pushKeyLoadFailed'));
        return;
      }

      const registration = await getServiceWorkerRegistration();
      await waitForSwActive(registration);

      const existing = await registration.pushManager.getSubscription();

      if (!('pushManager' in registration) || !registration.pushManager) {
        throw new Error('PushManager unavailable (requires installed PWA + iOS 16.4+)');
      }

      const subscription = existing ?? await withTimeout(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(key.publicKey),
        }),
        15000,
        'Push subscription timed out'
      );

      const json = subscription.toJSON();
      const keys = json.keys;
      if (!json.endpoint || !keys?.p256dh || !keys.auth) {
        throw new Error('Push subscription missing keys');
      }

      const ok = await withTimeout(
        apis.push.subscribe({
          endpoint: json.endpoint,
          keys: {
            p256dh: keys.p256dh,
            auth: keys.auth,
          },
          origin: typeof window !== 'undefined' ? window.location.origin : undefined,
          platform: getClientPlatform(),
        }),
        15000,
        'Push subscribe request timed out'
      );

      if (!ok?.ok) {
        toast.error(t('settings.notifications.page.toast.enableBackgroundFailed'));
        return;
      }

      setPushSubscribed(true);
      toast.success(t('settings.notifications.page.toast.backgroundEnabled'));
    } catch (error) {
      console.error('[Push] Enable failed:', error);
      const formatted = formatUnknownError(error);
      toast.error(t('settings.notifications.page.toast.enableBackgroundFailed'), {
        description: formatted.summary,
      });
    } finally {
      setPushBusy(false);
    }
  };

  const handleDisableBackgroundNotifications = async () => {
    if (!pushSupported) {
      setPushSubscribed(false);
      return;
    }

    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.push) {
      toast.error(t('settings.notifications.page.toast.pushApiUnavailable'));
      return;
    }

    setPushBusy(true);
    try {
      const registration = await getServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setPushSubscribed(false);
        return;
      }

      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await apis.push.unsubscribe({ endpoint });
      setPushSubscribed(false);
      toast.success(t('settings.notifications.page.toast.backgroundDisabled'));
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <>
        <SettingsSection
          settingsItem="notifications.delivery"
          title={t('settings.notifications.page.delivery.title')}
          divider={false}
        >
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            <SettingsCheckboxRow
              checked={nativeNotificationsEnabled && canShowNotifications}
              onChange={(checked) => {
                void handleToggleChange(checked);
              }}
              label={t('settings.notifications.page.delivery.enableLabel')}
              info={
                isBrowser
                  ? t('settings.notifications.page.delivery.browserPermissionHint')
                  : isVSCode
                    ? t('settings.notifications.page.delivery.vscodeHint')
                    : undefined
              }
              ariaLabel={t('settings.notifications.page.delivery.enableAria')}
            />

            {/* The native Capacitor app never notifies while focused (hard rule) and uses
                generic, non-customizable text, so the "notify while focused" toggle and the
                test button are hidden there. */}
            {nativeNotificationsEnabled && canShowNotifications && !isNativeApp && (
              <>
                <SettingsCheckboxRow
                  checked={notificationMode === 'always'}
                  onChange={(checked) => setNotificationMode(checked ? 'always' : 'hidden-only')}
                  label={t('settings.notifications.page.delivery.focusedLabel')}
                  ariaLabel={t('settings.notifications.page.delivery.focusedAria')}
                />

                <div className="py-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTestNotification()}
                  >
                    {t('settings.notifications.page.delivery.testAction')}
                  </Button>
                </div>
              </>
            )}
          </div>

          {isBrowser && (
            <div className="mt-1">
              {notificationPermission === 'denied' && (
                <p className="typography-meta text-[var(--status-error)] mt-1">
                  {t('settings.notifications.page.delivery.permissionDenied')}
                </p>
              )}
              {notificationPermission === 'granted' && !nativeNotificationsEnabled && (
                <p className="typography-meta text-muted-foreground/70 mt-1">
                  {t('settings.notifications.page.delivery.permissionGrantedButDisabled')}
                </p>
              )}
            </div>
          )}
        </SettingsSection>

        {nativeNotificationsEnabled && canShowNotifications && (
          <>
            <SettingsSection
              settingsItem="notifications.events"
              title={t('settings.notifications.page.events.title')}
            >
              <div className={SETTINGS_OPTION_STACK_CLASS}>
                <SettingsCheckboxRow
                  checked={notifyOnCompletion}
                  onChange={setNotifyOnCompletion}
                  label={t('settings.notifications.page.events.completionLabel')}
                  ariaLabel={t('settings.notifications.page.events.completionAria')}
                />

                <SettingsCheckboxRow
                  checked={notifyOnSubtasks}
                  onChange={setNotifyOnSubtasks}
                  label={t('settings.notifications.page.events.subtaskLabel')}
                  ariaLabel={t('settings.notifications.page.events.subtaskAria')}
                />

                <SettingsCheckboxRow
                  checked={notifyOnError}
                  onChange={setNotifyOnError}
                  label={t('settings.notifications.page.events.errorLabel')}
                  ariaLabel={t('settings.notifications.page.events.errorAria')}
                />

                <SettingsCheckboxRow
                  checked={notifyOnQuestion}
                  onChange={setNotifyOnQuestion}
                  label={t('settings.notifications.page.events.questionLabel')}
                  ariaLabel={t('settings.notifications.page.events.questionAria')}
                />
              </div>
            </SettingsSection>

            {!isNativeApp && (
            <SettingsSection
              title={t('settings.notifications.page.template.title')}
              description={(
                <>
                  {t('settings.notifications.page.template.variablesLabel')}{' '}
                  <code className="text-[var(--primary-base)]">{'{project_name}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{worktree}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{branch}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{session_name}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{agent_name}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{model_name}'}</code>{' '}
                  <code className="text-[var(--primary-base)]">{'{last_message}'}</code>
                </>
              )}
            >
              <SettingsTwoColumn className="gap-2 md:grid-cols-2 md:gap-3 lg:gap-3">
                {(['completion', 'subtask', 'error', 'question'] as const).map((event: NotificationTemplateEvent) => (
                  <section key={event} className="p-2">
                    <SettingsGroupTitle className="capitalize">
                      {t(TEMPLATE_EVENT_LABEL_KEYS[event])}
                    </SettingsGroupTitle>
                    <div className="mt-1.5 space-y-2">
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">{t('settings.notifications.page.template.field.title')}</label>
                        <Input
                          value={notificationTemplates[event].title}
                          onChange={(e) => updateTemplate(event, 'title', e.target.value)}
                          className="h-7"
                          placeholder={t(DEFAULT_NOTIFICATION_TEMPLATES[event].titleKey)}
                        />
                      </div>
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">{t('settings.notifications.page.template.field.message')}</label>
                        <Input
                          value={notificationTemplates[event].message}
                          onChange={(e) => updateTemplate(event, 'message', e.target.value)}
                          className="h-7"
                          placeholder={t(DEFAULT_NOTIFICATION_TEMPLATES[event].messageKey)}
                        />
                      </div>
                    </div>
                  </section>
                ))}
              </SettingsTwoColumn>
            </SettingsSection>
            )}

          </>
        )}

        <SettingsSection
          settingsItem="notifications.messengers"
          title={t('settings.notifications.page.messengers.title')}
          info={t('settings.notifications.page.messengers.info')}
        >
          {messengerLoadFailed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="typography-meta text-[var(--status-error)]">
                {t('settings.notifications.page.messengers.loadFailed')}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadMessengerSettings()}
              >
                {t('settings.notifications.page.messengers.retryAction')}
              </Button>
            </div>
          ) : messengerSettings ? (
            <div className="space-y-6">
              {MESSENGER_PROVIDERS.map(({ id, name, urlPlaceholder }) => {
                const providerState = messengerSettings[id];
                const inputValue = messengerInputs[id];
                const busy = messengerBusy === id;
                return (
                  <SettingsControlGroup
                    key={id}
                    title={name}
                    settingsItem={`notifications.messengers.${id}`}
                  >
                    <div className={SETTINGS_OPTION_STACK_CLASS}>
                      <SettingsCheckboxRow
                        checked={providerState.enabled}
                        disabled={busy}
                        onChange={(checked) => void handleMessengerToggle(id, checked)}
                        label={t('settings.notifications.page.messengers.enableLabel', { messenger: name })}
                        ariaLabel={t('settings.notifications.page.messengers.enableAria', { messenger: name })}
                      />

                      <SettingsStackedField
                        label={t('settings.notifications.page.messengers.webhookLabel')}
                        description={
                          providerState.webhookConfigured
                            ? t('settings.notifications.page.messengers.webhookConfigured')
                            : undefined
                        }
                        descriptionPlacement="after"
                      >
                        <Input
                          value={inputValue}
                          onChange={(e) => {
                            const value = e.target.value;
                            setMessengerInputs((current) => ({ ...current, [id]: value }));
                          }}
                          type="url"
                          autoComplete="off"
                          spellCheck={false}
                          className="h-8"
                          placeholder={
                            providerState.webhookConfigured
                              ? t('settings.notifications.page.messengers.replacePlaceholder')
                              : urlPlaceholder
                          }
                          aria-label={t('settings.notifications.page.messengers.webhookAria', { messenger: name })}
                        />
                      </SettingsStackedField>

                      <div className="flex flex-wrap items-center gap-2 py-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || inputValue.trim().length === 0}
                          onClick={() => void handleMessengerSaveWebhook(id, name)}
                        >
                          {t('settings.notifications.page.messengers.saveAction')}
                        </Button>
                        {providerState.webhookConfigured && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleMessengerRemoveWebhook(id)}
                          >
                            {t('settings.notifications.page.messengers.removeAction')}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || (!providerState.webhookConfigured && inputValue.trim().length === 0)}
                          onClick={() => void handleMessengerTest(id, name)}
                        >
                          {t('settings.notifications.page.messengers.testAction')}
                        </Button>
                      </div>
                    </div>
                  </SettingsControlGroup>
                );
              })}
            </div>
          ) : null}
        </SettingsSection>

        {isBrowser && (
          <SettingsSection
            settingsItem="notifications.push"
            title={t('settings.notifications.page.push.title')}
          >
            <SettingsCheckboxRow
              checked={pushSupported ? pushSubscribed : false}
              disabled={!pushSupported || pushBusy}
              onChange={(checked) => {
                if (checked) {
                  void handleEnableBackgroundNotifications();
                } else {
                  void handleDisableBackgroundNotifications();
                }
              }}
              label={t('settings.notifications.page.push.enableLabel')}
              description={!pushSupported ? t('settings.notifications.page.push.unsupportedHint') : undefined}
              info={pushSupported ? t('settings.notifications.page.push.supportedHint') : undefined}
              ariaLabel={t('settings.notifications.page.push.enableAria')}
              labelAccessory={
                pushBusy ? (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-current text-muted-foreground animate-busy-pulse" aria-label={t('settings.notifications.page.push.loadingAria')} />
                ) : null
              }
            />
          </SettingsSection>
        )}
    </>
  );
};
