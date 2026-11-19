import { z } from 'zod';

const stringInput = z.string();
const MAX_ENDPOINT_PATH_LENGTH = 1024;
const hasControlCharacters = (value: string) => [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WHITESPACE = /\s/;

export const normalizeEndpointPath = (value: string | null | undefined) => {
  const input = stringInput.safeParse(value);
  if (!input.success) {
    return { value: undefined };
  }

  const trimmed = input.data.trim();
  if (!trimmed) {
    return { value: undefined };
  }

  if (trimmed.length > MAX_ENDPOINT_PATH_LENGTH) {
    return { error: `Endpoint path must be at most ${MAX_ENDPOINT_PATH_LENGTH} characters` };
  }
  if (hasControlCharacters(trimmed)) {
    return { error: 'Endpoint path must not contain control characters' };
  }
  if (WHITESPACE.test(trimmed)) {
    return { error: 'Endpoint path must not contain spaces' };
  }
  if (trimmed.includes('\\')) {
    return { error: 'Endpoint path must use forward slashes' };
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { error: 'Endpoint path must not include a query or fragment' };
  }
  if (ABSOLUTE_URL.test(trimmed) || trimmed.startsWith('//')) {
    return { error: 'Endpoint path must be a path, not a URL' };
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const isPlainSegment = (segment: string) => {
    if (!segment) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== '.'
      && decoded !== '..'
      && !decoded.includes('/')
      && !decoded.includes('\\')
      && !hasControlCharacters(decoded)
      && !WHITESPACE.test(decoded);
  };
  if (!withLeadingSlash.slice(1).split('/').every(isPlainSegment)) {
    return { error: 'Endpoint path must be a plain resource path' };
  }

  return { value: withLeadingSlash };
};

const resolveUrlString = (input: Parameters<typeof fetch>[0]) => {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return null;
  const parsed = stringInput.safeParse(input);
  if (parsed.success) return parsed.data;
  return null;
};

interface EndpointPathFetchOptions {
  endpointPath: string;
  defaultPath: string;
  baseFetch?: typeof fetch;
}

export const createEndpointPathFetch = ({ endpointPath, defaultPath, baseFetch = globalThis.fetch }: EndpointPathFetchOptions): typeof fetch => async (input, init) => {
  const rawUrl = resolveUrlString(input);
  if (!rawUrl) {
    return baseFetch(input, init);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return baseFetch(input, init);
  }

  if (!parsed.pathname.endsWith(defaultPath)) {
    return baseFetch(input, init);
  }

  parsed.pathname = `${parsed.pathname.slice(0, -defaultPath.length)}${endpointPath}`;
  return baseFetch(parsed.toString(), init);
};
