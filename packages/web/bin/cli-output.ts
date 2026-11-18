import {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  spinner,
  progress,
  cancel,
  isCancel,
} from '@clack/prompts';

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
}

type OutputModeOptions = OutputOptions | null | undefined;
type JsonPayload = JsonObject | readonly JsonPayload[] | string | number | boolean | null | undefined;
interface JsonObject {
  [key: string]: JsonPayload;
}
interface JsonEnvelope {
  messages?: unknown;
  status?: unknown;
  data?: unknown;
}

interface TunnelProviderIcons {
  cloudflare: string;
  [provider: string]: string;
}

const TUNNEL_PROVIDER_ICON: TunnelProviderIcons = {
  cloudflare: '☁',
};

function hasProviderName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatProviderWithIcon(provider: string | null | undefined) {
  if (!hasProviderName(provider)) {
    return 'unknown';
  }
  const normalized = provider.trim().toLowerCase();
  const icon = TUNNEL_PROVIDER_ICON[normalized];
  return icon ? `${icon} ${normalized}` : normalized;
}

function logStatus(status: 'success' | 'warning' | 'error' | 'info' | 'neutral', message: string, detail?: string) {
  const full = detail ? `${message}\n${detail}` : message;
  switch (status) {
    case 'success':
      log.success(full);
      break;
    case 'warning':
      log.warn(full);
      break;
    case 'error':
      log.error(full);
      break;
    case 'info':
    case 'neutral':
    default:
      log.info(full);
      break;
  }
}

const isTTY = Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY);

function isJsonMode(options: OutputModeOptions) {
  return Boolean(options?.json);
}

function isQuietMode(options: OutputModeOptions) {
  return Boolean(options?.quiet);
}

function shouldRenderHumanOutput(options: OutputModeOptions) {
  return !isJsonMode(options) && !isQuietMode(options);
}

function canPrompt(options: OutputModeOptions) {
  return shouldRenderHumanOutput(options) && isTTY;
}

function createSpinner(options: OutputModeOptions) {
  return canPrompt(options) ? spinner() : null;
}

async function createProgress(options: OutputModeOptions, config: Parameters<typeof progress>[0]) {
  return canPrompt(options) ? progress(config) : null;
}

function isOutputRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function printJson(payload: JsonPayload) {
  const base: JsonEnvelope = isOutputRecord(payload)
    ? { ...payload }
    : { data: payload };

  const messages = Array.isArray(base.messages) ? base.messages : undefined;
  const hasWarning = Boolean(messages?.some((entry) => entry?.level === 'warning'));
  const hasError = Boolean(messages?.some((entry) => entry?.level === 'error'));
  const normalizedStatus = base.status === 'ok' || base.status === 'warning' || base.status === 'error'
    ? base.status
    : (hasError ? 'error' : (hasWarning ? 'warning' : 'ok'));

  const output = {
    status: normalizedStatus,
    ...base,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  formatProviderWithIcon,
  logStatus,
};
