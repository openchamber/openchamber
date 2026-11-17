export class TrackerRouteError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TrackerRouteError';
    this.status = status;
    this.code = code;
  }
}

export const routeError = (status: number, code: string, message: string) => new TrackerRouteError(status, code, message);
