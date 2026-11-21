
const isSpreadableDetails = (value: unknown): value is object => Boolean(value && typeof value === 'object');

export function buildAppliedResponse<Details extends object>(message: string, details?: Details | null) {
  const response = { success: true, message };
  if (isSpreadableDetails(details)) return { ...response, ...details };
  return response;
}

export function buildExternalManualRestartResponse(message: string) {
  return {
    success: true,
    requiresReload: false,
    requiresManualRestart: true,
    message,
  };
}
