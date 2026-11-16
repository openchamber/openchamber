export function buildAppliedResponse(message: string, details?: Record<string, unknown> | null) {
  return {
    success: true,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}
