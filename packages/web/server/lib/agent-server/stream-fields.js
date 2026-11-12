import path from 'node:path';
import { z } from 'zod';
import { isRecord } from '../shared/guards.js';

export const text = z.string().max(200_000);
export const id = z.string().min(1).max(256);
export const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const time = z.number().finite();
export const directory = z.string().min(1).max(4096).refine((value) => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return !value.includes('\0') && !/^\/spaces(?:\/|$)/i.test(normalized);
});

// Objects in these contracts strip unknown fields. Dictionaries need the same
// provenance rule because a session id or a provider id can be an arbitrary key.
export const stripProvenance = (value) => {
  if (Array.isArray(value)) return value.map(stripProvenance);
  if (!isRecord(value)) return value;
  // A provenance `origin` is a label; an `origin` holding an object, an array or null is event data.
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => key !== 'spaceId' && (key !== 'origin' || entry === null || isRecord(entry) || Array.isArray(entry)))
    .map(([key, entry]) => [key, stripProvenance(entry)]));
};
