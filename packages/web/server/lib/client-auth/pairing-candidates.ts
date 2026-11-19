import type { Request } from '../shared/http-contracts.js';
import { isString } from './inputs.js';

export const normalizeCandidateUrl = (value: Request['body']) => {
  if (!isString(value) || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

export const candidateUrlType = (url: string) => {
  try {
    return new URL(url).protocol === 'https:' ? 'tunnel' : 'lan';
  } catch {
    return 'lan';
  }
};

export const isLoopbackCandidateUrl = (url: string) => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return true;
  }
};

export const isLocalOnlyCandidateSet = (candidates: readonly { type: string }[]) => (
  candidates.length > 0 && candidates.every((candidate) => candidate.type === 'lan')
);
