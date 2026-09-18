const DEFAULT_MAX_CHARS = 8_192;
const REDACTED = '[redacted]';
const SENSITIVE_QUERY_KEYS = /^(?:access_token|auth|authorization|credential|key|oauth_token|password|private_token|secret|token)$/i;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const stringValue = (value) => {
  if (value instanceof Error) {
    return [value.message, value.stderr, value.stdout].filter((part) => isString(part) && part).join('\n');
  }
  return String(value ?? '');
};

const redactUrl = (value) => {
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

const secretVariants = (secret) => {
  const raw = String(secret ?? '');
  if (!raw) return [];
  const variants = new Set([raw]);
  try {
    variants.add(encodeURI(raw));
    variants.add(encodeURIComponent(raw));
    variants.add(new URLSearchParams({ value: raw }).get('value'));
  } catch {
    // The raw value still gets removed when URL encoding cannot represent it.
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
};

export function redactGitText(value, { secrets = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
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

export function createGitRedactor({ secrets = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
  const options = { secrets: [...secrets], maxChars };
  return Object.freeze({
    text: (value) => redactGitText(value, options),
    result: (result = {}) => Object.freeze({
      stdout: redactGitText(result.stdout, options),
      stderr: redactGitText(result.stderr, options),
      message: redactGitText(result.message, options),
    }),
    error: (error, fallback = 'Git operation failed') => redactGitText(error, options).trim() || fallback,
  });
}
