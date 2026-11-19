export interface ControlErrorStash {
  ref: string;
  hash: string;
  message: string;
}

export interface ControlErrorDetails {
  partial?: unknown;
  partialAction?: unknown;
  sessionId?: unknown;
  directory?: unknown;
  goalConfigured?: unknown;
  code?: unknown;
  task?: unknown;
  busy?: 'queued' | 'running';
  stash?: ControlErrorStash;
}

export interface ControlErrorFields extends ControlErrorDetails {
  statusCode?: unknown;
  status?: unknown;
  message?: unknown;
  _tag?: unknown;
}

export const controlErrorFields = (cause: unknown): ControlErrorFields | undefined => cause == null ? undefined : Object(cause);

export class OpenChamberControlError extends Error {
  statusCode: number;
  declare partial?: unknown;
  declare partialAction?: unknown;
  declare sessionId?: unknown;
  declare directory?: unknown;
  declare goalConfigured?: unknown;
  declare code?: unknown;
  declare task?: unknown;
  declare busy?: 'queued' | 'running';
  declare stash?: ControlErrorStash;

  constructor(message: string | undefined, statusCode = 500, details: ControlErrorDetails = {}) {
    super(message);
    this.name = 'OpenChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (cause: unknown, fallbackMessage: string, fallbackStatus = 500) => {
  if (cause instanceof OpenChamberControlError) return cause;
  const message = cause instanceof Error ? cause.message : fallbackMessage;
  const fields = controlErrorFields(cause);
  const status = Number(fields?.statusCode) || Number(fields?.status) || fallbackStatus;
  const details: ControlErrorDetails = {};
  if (fields?.goalConfigured === true) details.goalConfigured = true;
  return new OpenChamberControlError(message || fallbackMessage, status, details);
};
