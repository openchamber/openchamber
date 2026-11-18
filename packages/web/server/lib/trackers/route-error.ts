export class TrackerRouteError<Code = unknown> extends Error {
  status: number;
  code: Code;

  constructor(status: number, code: Code, message: string | undefined) {
    super(message);
    this.name = 'TrackerRouteError';
    this.status = status;
    this.code = code;
  }
}

export const routeError = <Code>(status: number, code: Code, message: string | undefined) => new TrackerRouteError(status, code, message);
