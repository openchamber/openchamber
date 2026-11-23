import { isString } from '../shared/guards.js';

const DEFAULT_MAX_CHARS = 8_192;
const REDACTED = '[redacted]';
const SENSITIVE_QUERY_KEYS = /^(?:access_token|auth|authorization|credential|key|oauth_token|password|private_token|secret|token)$/i;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
// Converged with the source-control redactor's sensitive key set
// (lib/source-control/url-redaction.js, #1920/#2074): the same key/value
// and header shapes must not survive on one surface while the other
// strips them.
const SENSITIVE_TEXT_KEY_PATTERN = 'x-api-key|access[-_]token|api[-_]key|client[-_]secret|oauth[-_]token|private[-_]token|authorization|password|secret|token';

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
    // #2074/#2128: quoted JSON/Python values and scheme-headed assignment values leak
    // the credential after the scheme word here just as they did in
    // redactSensitiveText — redact inside the quotes / after the scheme,
    // preserving structure and the scheme word.
    .replace(new RegExp(`\\b(${SENSITIVE_TEXT_KEY_PATTERN})(["']?\\s*[:=]\\s*["'])((?:bearer|basic)\\s+)?[^\\s"',;]+`, 'gi'), `$1$2$3${REDACTED}`)
    .replace(new RegExp(`\\b(${SENSITIVE_TEXT_KEY_PATTERN})(\\s*[:=]\\s*(?:bearer|basic))\\s+[^\\s,;]+`, 'gi'), `$1$2 ${REDACTED}`)
    // #2463: ordinary mid-line assignments (fatal: api_key=..., msg: access_token: ...)
    // — the generic sensitive-key rule redactSensitiveText carries; without it an
    // echoed credential after other text on the line survived every pattern above.
    // The lookahead refuses bearer/basic-headed values so the scheme word is
    // preserved for the scheme-headed rule above, exactly as in the sibling.
    // Two deliberate differences from the sibling, both because this surface
    // redacts URLs first and keeps non-sensitive query params (the sibling
    // strips the whole query): '&' also ends the value, so a value cannot eat
    // '&ref=main'; and a value that is already the redaction marker — raw or
    // URL-encoded by the URL pass above — is left exactly as it is.
    .replace(
      new RegExp(`\\b(${SENSITIVE_TEXT_KEY_PATTERN})\\s*[:=]\\s*(?!(?:bearer|basic)\\s)([^\\s"',;&]+)`, 'gi'),
      (match, key: string, value: string) =>
        value === REDACTED || value === encodeURIComponent(REDACTED) ? match : `${key}=${REDACTED}`,
    )
    .replace(/^(\s*(?:password|oauth_token|access_token|private_token|token)\s*=).*$/gim, `$1${REDACTED}`)
    .replace(/\b(authorization|private-token|oauth-token)\s*[:=]\s*[^\s"',;]+/gi, `$1=${REDACTED}`);

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
