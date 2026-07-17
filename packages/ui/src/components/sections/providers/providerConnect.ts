export interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

export interface ProviderOption {
  id: string;
  name?: string;
}

export interface ProviderOAuthDetails {
  url?: string;
  instructions?: string;
  userCode?: string;
}

type ProviderOAuthTranslationKey =
  | 'settings.providers.page.toast.oauthStartFailed'
  | 'settings.providers.page.toast.oauthDetailsMissing'
  | 'settings.providers.page.toast.completeOAuthInBrowser';

type ProviderOAuthPendingState = { providerId: string; methodIndex: number } | null;
type SetStateAction<T> = T | ((current: T) => T);
type StateUpdater<T> = (value: SetStateAction<T>) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getProviderOptionLabel = (provider: ProviderOption) => provider.name || provider.id;

export const getProviderGroupKey = (provider: ProviderOption) => {
  const firstCharacter = getProviderOptionLabel(provider).trim().charAt(0).toUpperCase();
  if (firstCharacter >= 'A' && firstCharacter <= 'Z') {
    return firstCharacter;
  }
  if (firstCharacter >= '0' && firstCharacter <= '9') {
    return '0-9';
  }
  return '#';
};

export const filterUnconnectedProviders = (providers: ProviderOption[], query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return providers;
  }

  return providers.filter((provider) => {
    const label = getProviderOptionLabel(provider).toLowerCase();
    return label.includes(normalizedQuery) || provider.id.toLowerCase().includes(normalizedQuery);
  });
};

export const groupProviderOptions = (providers: ProviderOption[]) => {
  const groups = new Map<string, ProviderOption[]>();

  for (const provider of providers) {
    const groupKey = getProviderGroupKey(provider);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(provider);
    } else {
      groups.set(groupKey, [provider]);
    }
  }

  return Array.from(groups.entries()).sort(([groupA], [groupB]) => {
    if (groupA === '#') return 1;
    if (groupB === '#') return -1;
    return groupA.localeCompare(groupB);
  });
};

const parseProviderOAuthDetails = (payload: unknown): ProviderOAuthDetails => {
  const payloadRecord: Record<string, unknown> = isRecord(payload) ? payload : {};
  const nestedData = payloadRecord.data;
  const dataRecord: Record<string, unknown> = isRecord(nestedData) ? nestedData : payloadRecord;

  return {
    url:
      (typeof dataRecord.url === 'string' && dataRecord.url) ||
      (typeof dataRecord.verification_uri_complete === 'string' && dataRecord.verification_uri_complete) ||
      (typeof dataRecord.verification_uri === 'string' && dataRecord.verification_uri) ||
      undefined,
    instructions:
      (typeof dataRecord.instructions === 'string' && dataRecord.instructions) ||
      (typeof dataRecord.message === 'string' && dataRecord.message) ||
      undefined,
    userCode:
      (typeof dataRecord.user_code === 'string' && dataRecord.user_code) ||
      (typeof dataRecord.code === 'string' && dataRecord.code) ||
      (typeof dataRecord.userCode === 'string' && dataRecord.userCode) ||
      undefined,
  };
};

export const startProviderOAuth = async ({
  providerId,
  methodIndex,
  authorize,
  authBusyKeyRef,
  setAuthBusyKey,
  setOauthDetails,
  setPendingOAuth,
  toastMessage,
  toastError,
  t,
  onError,
}: {
  providerId: string;
  methodIndex: number;
  authorize: (input: { providerID: string; method: number }) => Promise<{ data: unknown; error?: unknown }>;
  authBusyKeyRef: { current: string | null };
  setAuthBusyKey: StateUpdater<string | null>;
  setOauthDetails: StateUpdater<Record<string, ProviderOAuthDetails>>;
  setPendingOAuth: StateUpdater<ProviderOAuthPendingState>;
  toastMessage: (message: string) => void;
  toastError: (message: string) => void;
  t: (key: ProviderOAuthTranslationKey) => string;
  onError?: (error: unknown) => void;
}) => {
  const busyKey = `oauth:${providerId}:${methodIndex}`;
  if (authBusyKeyRef.current === busyKey) {
    return false;
  }

  authBusyKeyRef.current = busyKey;
  setAuthBusyKey(busyKey);

  try {
    const result = await authorize({
      providerID: providerId,
      method: methodIndex,
    });
    if (result.error) {
      throw new Error(t('settings.providers.page.toast.oauthStartFailed'));
    }

    const details = parseProviderOAuthDetails(result.data);
    if (!details.url && !details.instructions && !details.userCode) {
      throw new Error(t('settings.providers.page.toast.oauthDetailsMissing'));
    }

    const detailsKey = `${providerId}:${methodIndex}`;
    setOauthDetails((prev) => ({
      ...prev,
      [detailsKey]: details,
    }));
    setPendingOAuth({ providerId, methodIndex });
    toastMessage(t('settings.providers.page.toast.completeOAuthInBrowser'));
    return true;
  } catch (error) {
    onError?.(error);
    toastError(t('settings.providers.page.toast.oauthStartFailed'));
    return false;
  } finally {
    if (authBusyKeyRef.current === busyKey) {
      authBusyKeyRef.current = null;
    }
    setAuthBusyKey((current) => (current === busyKey ? null : current));
  }
};
