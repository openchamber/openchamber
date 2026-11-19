import { isRecord as isObjectRecord } from '../shared/guards.js';
import type { OpenChamberMetadata, SessionMetadata, StoredPins } from './contracts.js';

export const isSessionMetadata = (value: unknown): value is SessionMetadata => isObjectRecord(value);

export const isOpenChamberMetadata = (value: unknown): value is OpenChamberMetadata => isObjectRecord(value);

export const isStoredPins = (value: unknown): value is StoredPins => isObjectRecord(value);

export const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

export const hasMessage = (value: unknown): value is { message: unknown } => (
  value !== null && value !== undefined && 'message' in Object(value)
);
