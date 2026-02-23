import React from 'react';
import { RiRestartLine } from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { GridLoader } from '@/components/ui/grid-loader';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { ButtonSmall } from '@/components/ui/button-small';
import { cn } from '@/lib/utils';

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
} as const;

const DEFAULT_SUMMARY_THRESHOLD = 200;
const DEFAULT_SUMMARY_LENGTH = 100;
const DEFAULT_MAX_LAST_MESSAGE_LENGTH = 250;

export const NotificationSettings: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const isDesktop = React.useMemo(() => isDesktopShell(), []);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isBrowser = !isDesktop && !isVSCode;
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
  const summarizeLastMessage = useUIStore(state => state.summarizeLastMessage);
  const setSummarizeLastMessage = useUIStore(state => state.setSummarizeLastMessage);
  const summaryThreshold = useUIStore(state => state.summaryThreshold);
  const setSummaryThreshold = useUIStore(state => state.setSummaryThreshold);
  const summaryLength = useUIStore(state => state.summaryLength);
  const setSummaryLength = useUIStore(state => state.setSummaryLength);
  const maxLastMessageLength = useUIStore(state => state.maxLastMessageLength);
  const setMaxLastMessageLength = useUIStore(state => state.setMaxLastMessageLength);

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
          toast.error('Notification permission denied', {
            description: 'Please enable notifications in your browser settings.',
          });
        }
      } catch (error) {
        console.error('Failed to request notification permission:', error);
        toast.error('Failed to request notification permission');
      }
    } else if (checked && notificationPermission === 'granted') {
      setNativeNotificationsEnabled(true);
    } else {
      setNativeNotificationsEnabled(false);
    }
  };

  const canShowNotifications = isDesktop || (isBrowser && typeof Notification !== 'undefined' && Notification.permission === 'granted');

  const updateTemplate = (
    event: 'completion' | 'error' | 'question' | 'subtask',
    field: 'title' | 'message',
    value: string,
  ) => {
    setNotificationTemplates({
      ...notificationTemplates,
      [event]: {
        ...notificationTemplates[event],
        [field]: value,
      },
    });
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

  const handleEnableBackgroundNotifications = async () => {
    if (!pushSupported) {
      toast.error('Push notifications not supported');
      return;
    }

    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.push) {
      toast.error('Push API not available');
      return;
    }

    setPushBusy(true);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        setNotificationPermission(permission);
        if (permission !== 'granted') {
          toast.error('Notification permission denied', {
            description: 'Enable notifications in your browser settings.',
          });
          return;
        }
      }

      if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        toast.error('Notification permission denied', {
          description: 'Enable notifications in your browser settings.',
        });
        return;
      }

      const key = await apis.push.getVapidPublicKey();
      if (!key?.publicKey) {
        toast.error('Failed to load push key');
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
        }),
        15000,
        'Push subscribe request timed out'
      );

      if (!ok?.ok) {
        toast.error('Failed to enable background notifications');
        return;
      }

      setPushSubscribed(true);
      toast.success('Background notifications enabled');
    } catch (error) {
      console.error('[Push] Enable failed:', error);
      const formatted = formatUnknownError(error);
      toast.error('Failed to enable background notifications', {
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
      toast.error('Push API not available');
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
      toast.success('Background notifications disabled');
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <div className="space-y-8">

        {/* --- Global Delivery Settings --- */}
        <div className="mb-8">
          <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">
                Notification Delivery
              </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0.5">
            <div
              className="group flex cursor-pointer items-center gap-2 py-1.5"
              role="button"
              tabIndex={0}
              aria-pressed={nativeNotificationsEnabled && canShowNotifications}
              onClick={() => {
                void handleToggleChange(!(nativeNotificationsEnabled && canShowNotifications));
              }}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  void handleToggleChange(!(nativeNotificationsEnabled && canShowNotifications));
                }
              }}
            >
              <Checkbox
                checked={nativeNotificationsEnabled && canShowNotifications}
                onChange={(checked) => {
                  void handleToggleChange(checked);
                }}
                ariaLabel="Enable notifications"
              />
              <span className="typography-ui-label text-foreground">Enable Notifications</span>
            </div>

            {nativeNotificationsEnabled && canShowNotifications && (
              <div
                className="group flex cursor-pointer items-center gap-2 py-1.5"
                role="button"
                tabIndex={0}
                aria-pressed={notificationMode === 'always'}
                onClick={() => setNotificationMode(notificationMode === 'always' ? 'hidden-only' : 'always')}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    setNotificationMode(notificationMode === 'always' ? 'hidden-only' : 'always');
                  }
                }}
              >
                <Checkbox
                  checked={notificationMode === 'always'}
                  onChange={(checked) => setNotificationMode(checked ? 'always' : 'hidden-only')}
                  ariaLabel="Notify while app is focused"
                />
                <span className="typography-ui-label text-foreground">Notify While App is Focused</span>
              </div>
            )}
          </section>

          {isBrowser && (
            <div className="mt-1 px-2">
              <p className="typography-meta text-muted-foreground/70">
                Your browser may ask for permission the first time.
              </p>
              {notificationPermission === 'denied' && (
                <p className="typography-meta text-[var(--status-error)] mt-1">
                  Notification permission denied. Enable it in your browser settings.
                </p>
              )}
              {notificationPermission === 'granted' && !nativeNotificationsEnabled && (
                <p className="typography-meta text-muted-foreground/70 mt-1">
                  Permission granted, but notifications are disabled.
                </p>
              )}
            </div>
          )}
          {isVSCode && (
            <div className="mt-1 px-2">
              <p className="typography-meta text-muted-foreground/70">
                VS Code runtime handles notifications separately natively.
              </p>
            </div>
          )}
        </div>

        {nativeNotificationsEnabled && canShowNotifications && (
          <>
            {/* --- Events --- */}
            <div className="mb-8">
              <div className="mb-1 px-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                  Notification Events
                </h3>
              </div>

              <section className="px-2 pb-2 pt-0 space-y-0.5">
                <div
                  className="group flex cursor-pointer items-center gap-2 py-1.5"
                  role="button"
                  tabIndex={0}
                  aria-pressed={notifyOnCompletion}
                  onClick={() => setNotifyOnCompletion(!notifyOnCompletion)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setNotifyOnCompletion(!notifyOnCompletion);
                    }
                  }}
                >
                  <Checkbox checked={notifyOnCompletion} onChange={setNotifyOnCompletion} ariaLabel="Agent completion" />
                  <span className="typography-ui-label text-foreground">Agent Completion</span>
                </div>

                <div
                  className="group flex cursor-pointer items-center gap-2 py-1.5"
                  role="button"
                  tabIndex={0}
                  aria-pressed={notifyOnSubtasks}
                  onClick={() => setNotifyOnSubtasks(!notifyOnSubtasks)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setNotifyOnSubtasks(!notifyOnSubtasks);
                    }
                  }}
                >
                  <Checkbox checked={notifyOnSubtasks} onChange={setNotifyOnSubtasks} ariaLabel="Subagent completion" />
                  <span className="typography-ui-label text-foreground">Subagent Completion</span>
                </div>

                <div
                  className="group flex cursor-pointer items-center gap-2 py-1.5"
                  role="button"
                  tabIndex={0}
                  aria-pressed={notifyOnError}
                  onClick={() => setNotifyOnError(!notifyOnError)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setNotifyOnError(!notifyOnError);
                    }
                  }}
                >
                  <Checkbox checked={notifyOnError} onChange={setNotifyOnError} ariaLabel="Agent errors" />
                  <span className="typography-ui-label text-foreground">Agent Errors</span>
                </div>

                <div
                  className="group flex cursor-pointer items-center gap-2 py-1.5"
                  role="button"
                  tabIndex={0}
                  aria-pressed={notifyOnQuestion}
                  onClick={() => setNotifyOnQuestion(!notifyOnQuestion)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setNotifyOnQuestion(!notifyOnQuestion);
                    }
                  }}
                >
                  <Checkbox checked={notifyOnQuestion} onChange={setNotifyOnQuestion} ariaLabel="Agent questions" />
                  <span className="typography-ui-label text-foreground">Agent Questions</span>
                </div>
              </section>
            </div>

            {/* --- Template Customization --- */}
            <div className="mb-8">
              <div className="mb-1 px-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                  Notification Templates
                </h3>
                <p className="typography-meta text-muted-foreground mt-0.5">
                  Variables: <code className="text-[var(--primary-base)]">{'{project_name}'}</code> <code className="text-[var(--primary-base)]">{'{worktree}'}</code> <code className="text-[var(--primary-base)]">{'{branch}'}</code> <code className="text-[var(--primary-base)]">{'{session_name}'}</code> <code className="text-[var(--primary-base)]">{'{agent_name}'}</code> <code className="text-[var(--primary-base)]">{'{model_name}'}</code> <code className="text-[var(--primary-base)]">{'{last_message}'}</code>
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
                {(['completion', 'subtask', 'error', 'question'] as const).map((event) => (
                  <section key={event} className="p-2">
                    <span className="typography-ui-label text-foreground font-normal capitalize block">
                      {event === 'subtask' ? 'Subagent Completion' : event}
                    </span>
                    <div className="mt-1.5 space-y-2">
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">Title</label>
                        <Input
                          value={notificationTemplates[event].title}
                          onChange={(e) => updateTemplate(event, 'title', e.target.value)}
                          className="h-7"
                          placeholder={DEFAULT_NOTIFICATION_TEMPLATES[event].title}
                        />
                      </div>
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">Message</label>
                        <Input
                          value={notificationTemplates[event].message}
                          onChange={(e) => updateTemplate(event, 'message', e.target.value)}
                          className="h-7"
                          placeholder={DEFAULT_NOTIFICATION_TEMPLATES[event].message}
                        />
                      </div>
                    </div>
                  </section>
                ))}
              </div>
            </div>

            {/* --- Summarization --- */}
            <div className="mb-8">
              <div className="mb-1 px-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                  AI Summarization
                </h3>
              </div>

              <section className="px-2 pb-2 pt-0 space-y-0.5">
                <div
                  className="group flex cursor-pointer items-center gap-2 py-1.5"
                  role="button"
                  tabIndex={0}
                  aria-pressed={summarizeLastMessage}
                  onClick={() => setSummarizeLastMessage(!summarizeLastMessage)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      setSummarizeLastMessage(!summarizeLastMessage);
                    }
                  }}
                >
                  <Checkbox
                    checked={summarizeLastMessage}
                    onChange={setSummarizeLastMessage}
                    ariaLabel="Summarize last message"
                  />
                  <span className="typography-ui-label text-foreground">Summarize Last Message</span>
                </div>

                {summarizeLastMessage ? (
                  <>
                    <div className="flex items-center gap-8 py-1.5 mt-1 border-t border-[var(--surface-subtle)]">
                      <div className="flex min-w-0 flex-col w-56 shrink-0">
                        <span className="typography-ui-label text-foreground">Threshold</span>
                        <span className="typography-meta text-muted-foreground">Messages longer than this will be summarized</span>
                      </div>
                      <div className="flex items-center gap-2 w-fit">
                        <NumberInput
                          value={summaryThreshold}
                          onValueChange={setSummaryThreshold}
                          min={50}
                          max={2000}
                          step={50}
                          className="w-20 tabular-nums"
                        />
                        <ButtonSmall
                          type="button"
                          variant="ghost"
                          onClick={() => setSummaryThreshold(DEFAULT_SUMMARY_THRESHOLD)}
                          disabled={summaryThreshold === DEFAULT_SUMMARY_THRESHOLD}
                          className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                          aria-label="Reset threshold"
                          title="Reset"
                        >
                          <RiRestartLine className="h-3.5 w-3.5" />
                        </ButtonSmall>
                      </div>
                    </div>
                    <div className="flex items-center gap-8 py-1.5">
                      <div className="flex min-w-0 flex-col w-56 shrink-0">
                        <span className="typography-ui-label text-foreground">Length</span>
                        <span className="typography-meta text-muted-foreground">Target character length of the summary</span>
                      </div>
                      <div className="flex items-center gap-2 w-fit">
                        <NumberInput
                          value={summaryLength}
                          onValueChange={setSummaryLength}
                          min={20}
                          max={500}
                          step={10}
                          className="w-20 tabular-nums"
                        />
                        <ButtonSmall
                          type="button"
                          variant="ghost"
                          onClick={() => setSummaryLength(DEFAULT_SUMMARY_LENGTH)}
                          disabled={summaryLength === DEFAULT_SUMMARY_LENGTH}
                          className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                          aria-label="Reset summary length"
                          title="Reset"
                        >
                          <RiRestartLine className="h-3.5 w-3.5" />
                        </ButtonSmall>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className={cn("py-1.5 mt-1 border-t border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                      <span className="typography-ui-label text-foreground">Max Length</span>
                      <span className="typography-meta text-muted-foreground">Truncate {'{last_message}'} to this length</span>
                    </div>
                    <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                      <NumberInput
                        value={maxLastMessageLength}
                        onValueChange={setMaxLastMessageLength}
                        min={50}
                        max={1000}
                        step={10}
                        className="w-20 tabular-nums"
                      />
                      <ButtonSmall
                        type="button"
                        variant="ghost"
                        onClick={() => setMaxLastMessageLength(DEFAULT_MAX_LAST_MESSAGE_LENGTH)}
                        disabled={maxLastMessageLength === DEFAULT_MAX_LAST_MESSAGE_LENGTH}
                        className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                        aria-label="Reset max message length"
                        title="Reset"
                      >
                        <RiRestartLine className="h-3.5 w-3.5" />
                      </ButtonSmall>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}

        {/* --- Background Push Notifications --- */}
        {isBrowser && (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">
                Background Push Notifications
              </h3>
            </div>

            <section className="px-2 pb-2 pt-0">
              <div className="flex items-start gap-2 py-1.5">
                <Checkbox
                  checked={pushSupported ? pushSubscribed : false}
                  disabled={!pushSupported || pushBusy}
                  onChange={(checked: boolean) => {
                    if (checked) {
                      void handleEnableBackgroundNotifications();
                    } else {
                      void handleDisableBackgroundNotifications();
                    }
                  }}
                  ariaLabel="Enable push notifications"
                />
                <div className="flex min-w-0 flex-col">
                  <span className={cn("typography-ui-label", !pushSupported ? "text-muted-foreground" : "text-foreground")}>Enable push notifications</span>
                  <span className="typography-meta text-muted-foreground">
                    {!pushSupported
                      ? "Push not supported. Desktop Chrome/Edge and Android support push. iOS requires an installed PWA."
                      : "Receive alerts via your operating system background service"}
                  </span>
                </div>
                {pushBusy && (
                  <div className="pt-0.5 text-muted-foreground">
                    <GridLoader size="sm" />
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

    </div>
  );
};
