export class SourceControlInstanceOtherProviderError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string) {
    super(message);
    this.name = 'SourceControlInstanceOtherProviderError';
    this.provider = provider;
  }
}

export class SourceControlInstanceAliasError extends Error {
  readonly reason: 'invalid' | 'taken';
  readonly alias: string;

  constructor(message: string, reason: 'invalid' | 'taken', alias: string) {
    super(message);
    this.name = 'SourceControlInstanceAliasError';
    this.reason = reason;
    this.alias = alias;
  }
}
