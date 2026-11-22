export class OpenChamberControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'OpenChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof OpenChamberControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  const details = {};
  if (error?.goalConfigured === true) details.goalConfigured = true;
  return new OpenChamberControlError(message || fallbackMessage, Number(error?.statusCode) || Number(error?.status) || fallbackStatus, details);
};
