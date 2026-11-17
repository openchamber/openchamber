export class QuotaRouteError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'QuotaRouteError';
    this.status = status;
    this.code = code;
  }
}
