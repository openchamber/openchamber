import { normalizeOriginInstance } from '../source-control/origin-instance.js';

/**
 * A Gitea instance is its origin: HTTPS, or HTTP on a loopback host. An
 * install under a sub-path (`ROOT_URL=https://host/gitea/`) is refused,
 * because repositories are matched as `<origin>/<owner>/<name>` and a path
 * prefix would read as an owner.
 */
export function normalizeGiteaInstance(value) {
  return normalizeOriginInstance(value, { label: 'Gitea' });
}
