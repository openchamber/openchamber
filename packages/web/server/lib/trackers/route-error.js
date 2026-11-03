/**
 * An error a tracker route answers with the status and code it carries. Only
 * the routes' own input checks and the extension layer (`extension-tracker.js`,
 * `extension-accounts.js`) throw these: a built-in's error that happens to
 * carry a status and a code (Linear's token failures do) stays 500 under
 * `/api/tracker`, as it is under the legacy `/api/linear` routes.
 */
export class TrackerRouteError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'TrackerRouteError';
    this.status = status;
    this.code = code;
  }
}

export const routeError = (status, code, message) => new TrackerRouteError(status, code, message);
