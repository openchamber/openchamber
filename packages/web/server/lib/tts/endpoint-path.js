/**
 * Endpoint path override for OpenAI-compatible speech and transcription.
 *
 * The OpenAI SDK writes the resource path itself: `/audio/speech` for TTS and
 * `/audio/transcriptions` for STT. A server can copy the OpenAI request body,
 * auth and response and still name the resource differently. Replacing that
 * last path segment is enough; the base URL prefix, the query and every request
 * option stay as they are.
 */

import { z } from 'zod';

const stringInput = z.string();
const MAX_ENDPOINT_PATH_LENGTH = 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WHITESPACE = /\s/;

/**
 * @param {unknown} value
 * @returns {{ value?: string, error?: string }}
 */
export const normalizeEndpointPath = (value) => {
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
  if (CONTROL_CHARACTERS.test(trimmed)) {
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
  // The URL parser collapses %2e%2e to a parent segment when the path is
  // assigned, which would walk out of the configured base path. Judge the
  // decoded segment so an encoded form cannot pass as a plain name.
  const isPlainSegment = (segment) => {
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
      && !CONTROL_CHARACTERS.test(decoded)
      && !WHITESPACE.test(decoded);
  };
  if (!withLeadingSlash.slice(1).split('/').every(isPlainSegment)) {
    return { error: 'Endpoint path must be a plain resource path' };
  }

  return { value: withLeadingSlash };
};

const resolveUrlString = (input) => {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return null;
  const parsed = stringInput.safeParse(input);
  if (parsed.success) return parsed.data;
  // The OpenAI SDK always passes a string URL. A Request carries its own body,
  // so rewriting it would drop that body; leave it untouched.
  return null;
};

/**
 * Wrap a fetch implementation so requests for `defaultPath` go to
 * `endpointPath` instead, keeping the origin, base path prefix and query.
 *
 * @param {{ endpointPath: string, defaultPath: string, baseFetch?: typeof fetch }} options
 * @returns {typeof fetch}
 */
export const createEndpointPathFetch = ({ endpointPath, defaultPath, baseFetch = globalThis.fetch }) => async (input, init) => {
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
