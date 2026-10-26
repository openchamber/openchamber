import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGitLabInstance(value) {
  return normalizeOriginInstance(value, { label: 'GitLab' });
}
