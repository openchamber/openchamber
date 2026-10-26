export class SpaceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SpaceError';
    this.code = code;
    this.details = details;
  }
}
