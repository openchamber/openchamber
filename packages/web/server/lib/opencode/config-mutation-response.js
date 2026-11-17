
export function buildAppliedResponse(message, details) {
  return {
    success: true,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}

export function buildExternalManualRestartResponse(message) {
  return {
    success: true,
    requiresReload: false,
    requiresManualRestart: true,
    message,
  };
}
