import type { I18nKey } from '@/lib/i18n';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const bareHost = (value: string): string => value.trim().toLowerCase().replace(/\.$/, '');

export const normalizeInstanceInput = (descriptor: SourceControlProviderDescriptor, raw: string): string | null => {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
  const { instances } = descriptor;
  const hostname = bareHost(url.hostname);
  if (!hostname) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
  const secure = url.protocol === 'https:'
    || (url.protocol === 'http:' && instances.allowLoopbackHttp && LOOPBACK_HOSTS.has(hostname));
  if (!secure) return null;
  if (url.port && !instances.allowPort) return null;

  const host = url.port ? `${hostname}:${url.port}` : hostname;
  const instance = instances.format === 'host' ? host : `${url.protocol}//${host}`;
  const refused = [...instances.reserved, ...(instances.legacyFlow ? [instances.legacyFlow.instance] : [])]
    .map(bareHost);
  if (refused.includes(instance) || refused.includes(host)) return null;
  return instance;
};

export const tokenCreationUrl = (descriptor: SourceControlProviderDescriptor, instance: string): string | null => {
  const createPath = descriptor.auth.token?.createPath;
  if (!createPath) return null;
  const origin = descriptor.instances.format === 'host' ? `https://${instance}` : instance;
  return `${origin}${createPath.startsWith('/') ? '' : '/'}${createPath}`;
};

export const hasUnknownSettingsField = (descriptor: SourceControlProviderDescriptor): boolean => (
  descriptor.settings.fields.some((field) => field.kind === 'unknown')
);

type ProviderSettingsCopy = {
  description: I18nKey;
  connected: I18nKey;
  notConnected: I18nKey;
  operationFailed: I18nKey;
  tokenRejected: I18nKey;
  tokenLabel: I18nKey;
  tokenInfo: I18nKey;
  createToken: I18nKey;
  tokenScopes: I18nKey;
  deviceLabel: I18nKey;
  connect: I18nKey;
  deviceWaiting: I18nKey;
  openProvider: I18nKey;
  cliLabel: I18nKey;
  cliInfo: I18nKey;
  enableCli: I18nKey;
  disableCli: I18nKey;
  useCli: I18nKey;
  instancesTitle: I18nKey;
  instanceLabel: I18nKey;
  instanceInfo: I18nKey;
  useInstance: I18nKey;
  addInstance: I18nKey;
  updateApp: I18nKey;
};

const SHARED_COPY = {
  connected: 'settings.sourceControl.provider.status.connected',
  notConnected: 'settings.sourceControl.provider.status.notConnected',
  operationFailed: 'settings.sourceControl.instance.status.operationFailed',
  tokenScopes: 'settings.sourceControl.token.scopes',
  deviceLabel: 'settings.sourceControl.device.label',
  connect: 'settings.sourceControl.actions.connect',
  deviceWaiting: 'settings.sourceControl.device.waiting',
  openProvider: 'settings.sourceControl.actions.openProvider',
  cliLabel: 'settings.sourceControl.cli.label',
  cliInfo: 'settings.sourceControl.cli.info',
  enableCli: 'settings.sourceControl.cli.enable',
  disableCli: 'settings.sourceControl.cli.disable',
  useCli: 'settings.sourceControl.cli.use',
  instancesTitle: 'settings.sourceControl.instance.othersTitle',
  instanceLabel: 'settings.sourceControl.instance.label',
  useInstance: 'settings.sourceControl.instance.use',
  addInstance: 'settings.sourceControl.instance.add',
  updateApp: 'settings.sourceControl.provider.updateApp',
} as const satisfies Omit<ProviderSettingsCopy, 'description' | 'instanceInfo' | keyof typeof TOKEN_COPY>;

const usesHttpPassword = (descriptor: SourceControlProviderDescriptor): boolean => (
  descriptor.settings.fields.some((field) => field.kind === 'http-password')
);

export const asksForUsername = (descriptor: SourceControlProviderDescriptor): boolean => (
  descriptor.settings.fields.some((field) => field.kind === 'username')
);

const TOKEN_COPY = {
  tokenRejected: 'settings.sourceControl.token.rejected',
  tokenLabel: 'settings.sourceControl.token.label',
  tokenInfo: 'settings.sourceControl.token.info',
  createToken: 'settings.sourceControl.token.create',
} as const satisfies Partial<ProviderSettingsCopy>;

const HTTP_PASSWORD_COPY = {
  tokenRejected: 'settings.sourceControl.field.httpPassword.rejected',
  tokenLabel: 'settings.sourceControl.field.httpPassword.label',
  tokenInfo: 'settings.sourceControl.field.httpPassword.info',
  createToken: 'settings.sourceControl.field.httpPassword.create',
} as const satisfies Partial<ProviderSettingsCopy>;

export const providerSettingsCopy = (descriptor: SourceControlProviderDescriptor): ProviderSettingsCopy => ({
  ...SHARED_COPY,
  ...(usesHttpPassword(descriptor) ? HTTP_PASSWORD_COPY : TOKEN_COPY),
  description: `settings.sourceControl.provider.description.${descriptor.terminology.changeRequest}`,
  instanceInfo: descriptor.instances.allowLoopbackHttp
    ? 'settings.sourceControl.instance.infoLoopback'
    : 'settings.sourceControl.instance.info',
});
