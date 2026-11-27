import type { HostRequestErrorCode } from './contract.ts';

export class HostRequestError extends Error {
  readonly code: HostRequestErrorCode;

  constructor(code: HostRequestErrorCode, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}
