/**
 * MiniMax Provider - Business status
 *
 * The remains endpoints answer HTTP 200 and report failures in `base_resp`.
 * Web/Electron and VS Code both import this module so the card says the same.
 * @module quota/providers/minimax-status
 */

// MiniMax answers 1004 ("cookie is missing, log in again") to a valid
// Subscription Key: these endpoints share usage only with a web login (#5839).
const NO_USAGE_FOR_KEY = 1004;

/** The card's error for a failed `base_resp`, or null when MiniMax reports success. */
export const miniMaxStatusError = (baseResp) => {
  if (!baseResp) return null;
  const statusCode = Number(baseResp.status_code);
  if (statusCode === 0) return null;
  if (statusCode === NO_USAGE_FOR_KEY) return "MiniMax doesn't share limits for this key";
  const statusMsg = String(baseResp.status_msg ?? '').trim();
  return statusMsg || `API error: ${baseResp.status_code ?? 'unknown'}`;
};
