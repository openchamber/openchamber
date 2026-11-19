import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGerritInstance(value: string | undefined) {
  return normalizeOriginInstance(value, { label: 'Gerrit' });
}
