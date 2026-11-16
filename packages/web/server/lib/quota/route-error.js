/**
 * An error a quota route answers with the status and code it carries. Only
 * the extension layer (`extension-quota.js`) throws these: a built-in's
 * failure is a result with `ok: false`, and any other throw stays 500 under
 * `/api/quota`, whatever fields it happens to carry.
 */
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
