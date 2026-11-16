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
