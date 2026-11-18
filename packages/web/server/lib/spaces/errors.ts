export class SpaceError<Details = null> extends Error {
  code: string;
  details: Details | null;

  constructor(code: string, message: string, details: Details | null = null) {
    super(message);
    this.name = 'SpaceError';
    this.code = code;
    this.details = details;
  }
}
