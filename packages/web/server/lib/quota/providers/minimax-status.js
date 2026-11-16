
// external: #5839 MiniMax returns cookie-required error 1004 for valid Subscription Keys.
const NO_USAGE_FOR_KEY = 1004;

export const miniMaxStatusError = (baseResp) => {
  if (!baseResp) return null;
  const statusCode = Number(baseResp.status_code);
  if (statusCode === 0) return null;
  if (statusCode === NO_USAGE_FOR_KEY) return "MiniMax doesn't share limits for this key";
  const statusMsg = String(baseResp.status_msg ?? '').trim();
  return statusMsg || `API error: ${baseResp.status_code ?? 'unknown'}`;
};
