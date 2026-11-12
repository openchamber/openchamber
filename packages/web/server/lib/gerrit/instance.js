import { normalizeOriginInstance } from '../source-control/origin-instance.js';

/**
 * A Gerrit instance is its origin: HTTPS, or HTTP on a loopback host (a
 * local `--dev` site). An install under a sub-path (`canonicalWebUrl =
 * https://host/r/`) is refused: projects are matched as `<origin>/<name>`
 * and REST paths as `<origin>/a/...`, so a path prefix would read as part of
 * a project name.
 */
export function normalizeGerritInstance(value) {
  return normalizeOriginInstance(value, { label: 'Gerrit' });
}
