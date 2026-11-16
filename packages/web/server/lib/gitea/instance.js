import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGiteaInstance(value) {
  return normalizeOriginInstance(value, { label: 'Gitea' });
}
