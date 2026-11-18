import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGerritInstance(value: string) {
  return normalizeOriginInstance(value, { label: 'Gerrit' });
}
