import React from 'react';
import { RiInformationLine, RiRestartLine } from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { updateDesktopSettings } from '@/lib/persistence';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { GridLoader } from '@/components/ui/grid-loader';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { m } from '@/lib/i18n/messages';

const UTILITY_PROVIDER_ID = 'zen';
const UTILITY_PREFERRED_MODEL_ID = 'big-pickle';
const UTILITY_NOT_SELECTED_VALUE = '__not_selected__';

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
  const providers = useConfigStore((state) => state.providers);
  const settingsZenModel = useConfigStore((state) => state.settingsZenModel);
  const setSettingsZenModel = useConfigStore((state) => state.setSettingsZenModel);

  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission>('default');
  const [pushSupported, setPushSupported] = React.useState(false);
  const [pushSubscribed, setPushSubscribed] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);
  const [fetchedZenModels, setFetchedZenModels] = React.useState<Array<{ id: string; name: string }>>([]);

  const DEFAULT_NOTIFICATION_TEMPLATES = React.useMemo(() => ({
    completion: { title: m.notifDefaultTitleReady(), message: m.notifDefaultMessageCompleted() },
    error: { title: m.notifDefaultTitleError(), message: '{last_message}' },
    question: { title: m.notifDefaultTitleInputNeeded(), message: '{last_message}' },
    subtask: { title: m.notifDefaultTitleReady(), message: m.notifDefaultMessageCompleted() },
  }) as const, []);

  const EVENT_LABELS = React.useMemo(() => ({
    completion: m.notifEventCompletion(),
    error: m.notifEventError(),
    question: m.notifEventQuestion(),
    subtask: m.notifEventSubtask(),
  }) as const, []);

  const providerZenModels = React.useMemo(() => {
    const zenProvider = providers.find((provider) => provider.id === UTILITY_PROVIDER_ID);
    const models = Array.isArray(zenProvider?.models) ? zenProvider.models : [];
    return models
      .map((model: Record<string, unknown>) => {
        const id = typeof model.id === 'string' ? model.id.trim() : '';
        if (!id) {
          return null;
        }
        const name = typeof model.name === 'string' && model.name.trim().length > 0 ? model.name.trim() : id;
        return { id, name };
      })
      .filter((model): model is { id: string; name: string } => model !== null);
  }, [providers]);

  React.useEffect(() => {
    if (providerZenModels.length > 0) {
      setFetchedZenModels([]);
      return;
    }

    const controller = new AbortController();
    void fetch('/api/zen/models', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          return [] as Array<{ id: string; name: string }>;
        }
        const payload = await response.json().catch(() => ({}));
        const models = Array.isArray(payload?.models) ? payload.models : [];
        return models
          .map((entry: unknown) => {
            const id = typeof (entry as { id?: unknown })?.id === 'string'
              ? (entry as { id: string }).id.trim()
              : '';
            if (!id) {
              return null;
            }
            return { id, name: id };
          })
          .filter((entry: { id: string; name: string } | null): entry is { id: string; name: string } => entry !== null);
      })
      .then((models) => {
        setFetchedZenModels(models);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          console.warn('Failed to load zen utility models:', error);
        }
      });

    return () => {
      controller.abort();
    };
  }, [providerZenModels]);

  const utilityModelOptions = React.useMemo(() => {
    return providerZenModels.length > 0 ? providerZenModels : fetchedZenModels;
  }, [fetchedZenModels, providerZenModels]);

  const utilitySelectedModelId = React.useMemo(() => {
    if (settingsZenModel && utilityModelOptions.some((model) => model.id === settingsZenModel)) {
      return settingsZenModel;
    }
    if (utilityModelOptions.some((model) => model.id === UTILITY_PREFERRED_MODEL_ID)) {
      return UTILITY_PREFERRED_MODEL_ID;
    }
    return utilityModelOptions[0]?.id ?? '';
  }, [settingsZenModel, utilityModelOptions]);

  const handleUtilityModelChange = React.useCallback(
    async (value: string) => {
      const modelId = value === UTILITY_NOT_SELECTED_VALUE ? undefined : value;
      setSettingsZenModel(modelId);
      try {
        await updateDesktopSettings({
          zenModel: modelId ?? '',
          gitProviderId: '',
          gitModelId: '',
        });
      } catch (error) {
        console.warn('Failed to save utility model setting:', error);
      }
    },
    [setSettingsZenModel]
  );

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
          toast.error(m.notifToastPermissionDenied(), {
            description: m.notifToastPermissionDeniedDesc(),
          });
        }
      } catch (error) {
        console.error('Failed to request notification permission:', error);
        toast.error(m.notifToastRequestPermissionFailed());
      }
    } else if (checked && notificationPermission === 'granted') {
      setNativeNotificationsEnabled(true);
    } else {
      setNativeNotificationsEnabled(false);
    }
  };

  const canShowNotifications = isDesktop || isVSCode || (isBrowser && typeof Notification !== 'undefined' && Notification.permission === 'granted');

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
      toast.error(m.notifToastPushNotSupported());
      return;
    }

    const apis = getRegisteredRuntimeAPIs();
    if (!apis?.push) {
      toast.error(m.notifToastPushApiNotAvailable());
      return;
    }

    setPushBusy(true);
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        setNotificationPermission(permission);
        if (permission !== 'granted') {
          toast.error(m.notifToastPermissionDenied(), {
            description: m.notifToastPermissionDeniedEnableDesc(),
          });
          return;
        }
      }

      if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        toast.error(m.notifToastPermissionDenied(), {
          description: m.notifToastPermissionDeniedEnableDesc(),
        });
        return;
      }

      const key = await apis.push.getVapidPublicKey();
      if (!key?.publicKey) {
        toast.error(m.notifToastLoadKeyFailed());
        return;
      }

      const registration = await getServiceWorkerRegistration();
      await waitForSwActive(registration);

      const existing = await registration.pushManager.getSubscription();

      if (!('pushManager' in registration) || !registration.pushManager) {
        throw new Error(m.notifPushManagerUnavailable());
      }

      const subscription = existing ?? await withTimeout(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(key.publicKey),
        }),
        15000,
        m.notifPushSubscriptionTimedOut()
      );

      const json = subscription.toJSON();
      const keys = json.keys;
      if (!json.endpoint || !keys?.p256dh || !keys.auth) {
        throw new Error(m.notifPushSubscriptionMissingKeys());
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
        m.notifPushRequestTimedOut()
      );

      if (!ok?.ok) {
        toast.error(m.notifToastEnableFailed());
        return;
      }

      setPushSubscribed(true);
      toast.success(m.notifToastBgEnabled());
    } catch (error) {
      console.error('[Push] Enable failed:', error);
      const formatted = formatUnknownError(error);
      toast.error(m.notifToastEnableFailedDesc(), {
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
      toast.error(m.notifToastPushApiNotAvailableDisable());
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
      toast.success(m.notifToastBgDisabled());
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
                {m.notifDeliveryTitle()}              </h3>
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
                ariaLabel={m.notifEnableAria()}
              />
              <span className="typography-ui-label text-foreground">{m.notifEnable()}</span>
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
                  ariaLabel={m.notifWhileFocusedAria()}
                />
                  <span className="typography-ui-label text-foreground">{m.notifWhileFocused()}</span>
              </div>
            )}
          </section>

          {isBrowser && (
            <div className="mt-1 px-2">
              <p className="typography-meta text-muted-foreground/70">
                {m.notifBrowserPermissionHint()}
              </p>
              {notificationPermission === 'denied' && (
                <p className="typography-meta text-[var(--status-error)] mt-1">
                  {m.notifPermissionDeniedHint()}
                </p>
              )}
              {notificationPermission === 'granted' && !nativeNotificationsEnabled && (
                <p className="typography-meta text-muted-foreground/70 mt-1">
                  {m.notifPermissionGrantedDisabled()}
                </p>
              )}
            </div>
          )}
          {isVSCode && (
            <div className="mt-1 px-2">
              <p className="typography-meta text-muted-foreground/70">
                {m.notifVscodeHint()}
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
                  {m.notifEventsTitle()}                </h3>
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
                  <Checkbox checked={notifyOnCompletion} onChange={setNotifyOnCompletion} ariaLabel={m.notifAgentCompletionAria()} />
                  <span className="typography-ui-label text-foreground">{m.notifAgentCompletion()}</span>
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
                  <Checkbox checked={notifyOnSubtasks} onChange={setNotifyOnSubtasks} ariaLabel={m.notifSubagentCompletionAria()} />
                  <span className="typography-ui-label text-foreground">{m.notifSubagentCompletion()}</span>
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
                  <Checkbox checked={notifyOnError} onChange={setNotifyOnError} ariaLabel={m.notifAgentErrorsAria()} />
                  <span className="typography-ui-label text-foreground">{m.notifAgentErrors()}</span>
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
                  <Checkbox checked={notifyOnQuestion} onChange={setNotifyOnQuestion} ariaLabel={m.notifAgentQuestionsAria()} />
                  <span className="typography-ui-label text-foreground">{m.notifAgentQuestions()}</span>
                </div>
              </section>
            </div>

            {/* --- Template Customization --- */}
            <div className="mb-8">
              <div className="mb-1 px-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                  {m.notifTemplatesTitle()}                </h3>
                <p className="typography-meta text-muted-foreground mt-0.5">
                  {m.notifVariables()}: <code className="text-[var(--primary-base)]">{'{project_name}'}</code> <code className="text-[var(--primary-base)]">{'{worktree}'}</code> <code className="text-[var(--primary-base)]">{'{branch}'}</code> <code className="text-[var(--primary-base)]">{'{session_name}'}</code> <code className="text-[var(--primary-base)]">{'{agent_name}'}</code> <code className="text-[var(--primary-base)]">{'{model_name}'}</code> <code className="text-[var(--primary-base)]">{'{last_message}'}</code>
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
                {(['completion', 'subtask', 'error', 'question'] as const).map((event) => (
                  <section key={event} className="p-2">
                    <span className="typography-ui-label text-foreground font-normal capitalize block">
                      {event === 'subtask' ? m.notifSubagentCompletionLabel() : EVENT_LABELS[event]}
                    </span>
                    <div className="mt-1.5 space-y-2">
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">{m.notifTemplateTitle()}</label>
                        <Input
                          value={notificationTemplates[event].title}
                          onChange={(e) => updateTemplate(event, 'title', e.target.value)}
                          className="h-7"
                          placeholder={DEFAULT_NOTIFICATION_TEMPLATES[event].title}
                        />
                      </div>
                      <div>
                        <label className="typography-micro text-muted-foreground block mb-1">{m.notifTemplateMessage()}</label>
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
                  {m.notifSummarizationTitle()}                </h3>
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
                    ariaLabel={m.notifSummarizeLastAria()}
                  />
                  <span className="typography-ui-label text-foreground">{m.notifSummarizeLast()}</span>
                </div>

                <div className={cn("flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8")}>
                  <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label text-foreground">{m.notifSummarizationModel()}</span>
                      <Tooltip delayDuration={1000}>
                        <TooltipTrigger asChild>
                          <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent sideOffset={8} className="max-w-xs">
                          {m.notifSummarizationModelTooltip()}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                    <Select
                      value={utilitySelectedModelId || UTILITY_NOT_SELECTED_VALUE}
                      onValueChange={handleUtilityModelChange}
                    >
                      <SelectTrigger className="w-fit min-w-[220px]">
                        <SelectValue placeholder={m.notifNotSelected()} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UTILITY_NOT_SELECTED_VALUE}>{m.notifNotSelected()}</SelectItem>
                        {utilityModelOptions.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {summarizeLastMessage ? (
                  <>
                    <div className="flex items-center gap-8 py-1.5 mt-1 border-t border-[var(--surface-subtle)]">
                      <div className="flex min-w-0 flex-col w-56 shrink-0">
                        <span className="typography-ui-label text-foreground">{m.notifThreshold()}</span>
                        <span className="typography-meta text-muted-foreground">{m.notifThresholdDesc()}</span>
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
                        <Button size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => setSummaryThreshold(DEFAULT_SUMMARY_THRESHOLD)}
                          disabled={summaryThreshold === DEFAULT_SUMMARY_THRESHOLD}
                          className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                          aria-label={m.notifResetThreshold()}
                          title={m.commonReset()}
                        >
                          <RiRestartLine className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center gap-8 py-1.5">
                      <div className="flex min-w-0 flex-col w-56 shrink-0">
                        <span className="typography-ui-label text-foreground">{m.notifLength()}</span>
                        <span className="typography-meta text-muted-foreground">{m.notifLengthDesc()}</span>
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
                        <Button size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => setSummaryLength(DEFAULT_SUMMARY_LENGTH)}
                          disabled={summaryLength === DEFAULT_SUMMARY_LENGTH}
                          className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                          aria-label={m.notifResetSummaryLength()}
                          title={m.commonReset()}
                        >
                          <RiRestartLine className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className={cn("py-1.5 mt-1 border-t border-[var(--surface-subtle)]", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
                    <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "w-56 shrink-0")}>
                      <span className="typography-ui-label text-foreground">{m.notifMaxLength()}</span>
                      <span className="typography-meta text-muted-foreground">{m.notifMaxLengthDesc({ last_message: '{last_message}' })}</span>
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
                      <Button size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => setMaxLastMessageLength(DEFAULT_MAX_LAST_MESSAGE_LENGTH)}
                        disabled={maxLastMessageLength === DEFAULT_MAX_LAST_MESSAGE_LENGTH}
                        className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                        aria-label={m.notifResetMaxMessageLength()}
                        title={m.commonReset()}
                      >
                        <RiRestartLine className="h-3.5 w-3.5" />
                      </Button>
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
                {m.notifPushTitle()}              </h3>
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
                  ariaLabel={m.notifPushEnableAria()}
                />
                <div className="flex min-w-0 flex-col">
                  <span className={cn("typography-ui-label", !pushSupported ? "text-muted-foreground" : "text-foreground")}>{m.notifPushEnable()}</span>
                  <span className="typography-meta text-muted-foreground">
                    {!pushSupported
                      ? m.notifPushNotSupported()
                      : m.notifPushSupportedDesc()}
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
