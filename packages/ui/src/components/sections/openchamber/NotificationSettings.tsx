import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getClientPlatform } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import {
  SettingsSection,
  SettingsTwoColumn,
  SettingsCheckboxRow,
  SettingsGroupTitle,
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
