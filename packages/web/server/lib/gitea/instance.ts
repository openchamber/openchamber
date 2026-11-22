import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGiteaInstance(value: string | undefined) {
  return normalizeOriginInstance(value, { label: 'Gitea' });
}
