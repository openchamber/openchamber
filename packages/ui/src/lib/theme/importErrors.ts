export type ThemeImportErrorCode = 'invalid' | 'include' | 'size' | 'background' | 'save' | 'connection' | 'unsupported' | 'conflict';

export class ThemeImportError extends Error {
  constructor(public readonly code: ThemeImportErrorCode) {
    super(code);
    this.name = 'ThemeImportError';
  }
}

export const MAX_THEME_IMPORT_BYTES = 512 * 1024;
