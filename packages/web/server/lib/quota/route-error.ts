export class QuotaRouteError extends Error {
  declare status: number;
  declare code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'QuotaRouteError';
    this.status = status;
    this.code = code;
  }
}
