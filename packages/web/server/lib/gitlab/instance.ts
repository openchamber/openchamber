import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGitLabInstance(value: string) {
  return normalizeOriginInstance(value, { label: 'GitLab' });
}
