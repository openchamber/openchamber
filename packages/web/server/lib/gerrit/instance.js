import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGerritInstance(value) {
  return normalizeOriginInstance(value, { label: 'Gerrit' });
}
