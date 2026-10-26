export const PROVIDER_AUTH_FAILURE_MESSAGE = "Authentication failed for this provider. Please re-authenticate and retry.";

export const isLikelyProviderAuthFailure = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const detail = value.toLowerCase().trim();
  if (!detail) {
    return false;
  }

  if (
    detail.includes("token refresh failed") ||
    detail.includes("unauthorized") ||
    detail.includes("invalid token") ||
    detail.includes("expired token")
  ) {
    return true;
  }

  const hasOauth = detail.includes("oauth");
  const hasOauthFailure =
    detail.includes("failed") || detail.includes("invalid") || detail.includes("expired");
  if (hasOauth && hasOauthFailure) {
    return true;
  }

  const has401 = /\b401\b/.test(detail);
  const hasAuthContext =
    detail.includes("auth") || detail.includes("token") || detail.includes("unauthorized");

  return has401 && hasAuthContext;
};
