import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGitLabInstance(value, options = {}) {
  return normalizeOriginInstance(value, { label: 'GitLab', ...options });
}
