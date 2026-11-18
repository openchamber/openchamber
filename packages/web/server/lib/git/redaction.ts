import { isString } from '../shared/guards.js';

const DEFAULT_MAX_CHARS = 8_192;
const REDACTED = '[redacted]';
const SENSITIVE_QUERY_KEYS = /^(?:access_token|auth|authorization|credential|key|oauth_token|password|private_token|secret|token)$/i;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

interface GitOutput {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

interface RedactionOptions {
  secrets?: (string | undefined)[];
  maxChars?: number;
}

const isOutputError = (value: unknown): value is Error & GitOutput => value instanceof Error;

const stringValue = <Value>(value: Value) => {
  if (isOutputError(value)) {
    return [value.message, value.stderr, value.stdout].filter((part) => isString(part) && part).join('\n');
  }
  return String(value ?? '');
};

const redactUrl = (value: string) => {
  let suffix = '';
  let candidate = value;
  while (/[),.;\]}]$/.test(candidate)) {
    suffix = candidate.slice(-1) + suffix;
    candidate = candidate.slice(0, -1);
  }

  try {
    const url = new URL(candidate);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, REDACTED);
    }
    return `${url.toString()}${suffix}`;
  } catch {
    return value;
  }
};

const addEncodedVariants = (raw: string, variants: Set<string | null>) => {
  try {
    variants.add(encodeURI(raw));
    variants.add(encodeURIComponent(raw));
    variants.add(new URLSearchParams({ value: raw }).get('value'));
  } catch {
    return;
  }
};

const secretVariants = (secret: string | undefined) => {
  const raw = String(secret ?? '');
  if (!raw) return [];
  const variants = new Set<string | null>([raw]);
  addEncodedVariants(raw, variants);
  return [...variants].filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length);
};

export function redactGitText<Value>(value: Value, { secrets = [], maxChars = DEFAULT_MAX_CHARS }: RedactionOptions = {}) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
  let text = stringValue(value)
    .replace(URL_PATTERN, redactUrl)
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(/^(\s*(?:password|oauth_token|access_token|private_token|token)\s*=).*$/gim, `$1${REDACTED}`)
    .replace(/\b(authorization|private-token|oauth-token)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`);

  for (const secret of secrets.flatMap(secretVariants)) {
    text = text.split(secret).join(REDACTED);
  }

  if (text.length <= limit) return text;
  const marker = '\n...[truncated]';
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`.slice(0, limit);
}

export function createGitRedactor({ secrets = [], maxChars = DEFAULT_MAX_CHARS }: RedactionOptions = {}) {
  const options = { secrets: [...secrets], maxChars };
  return Object.freeze({
    text: <Value>(value: Value) => redactGitText(value, options),
    result: (result: GitOutput = {}) => Object.freeze({
      stdout: redactGitText(result.stdout, options),
      stderr: redactGitText(result.stderr, options),
      message: redactGitText(result.message, options),
    }),
    error: <Value>(error: Value, fallback = 'Git operation failed') => redactGitText(error, options).trim() || fallback,
  });
}
