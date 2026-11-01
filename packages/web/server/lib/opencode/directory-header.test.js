import { describe, expect, it } from 'vitest';
import { directoryHeaderForOpenCode, wireForwardedDirectoryHeaders } from './directory-header.js';

const UNC = '//wsl.localhost/Ubuntu/home/ocrunner/font5884-wsl';
const WIRED = '\\\\wsl.localhost\\Ubuntu\\home\\ocrunner\\font5884-wsl';

describe('directoryHeaderForOpenCode', () => {
  it('sends a normalized UNC path in the form Windows OpenCode resolves', () => {
    expect(directoryHeaderForOpenCode(UNC)).toBe(WIRED);
    expect(directoryHeaderForOpenCode(encodeURIComponent(UNC))).toBe(WIRED);
    expect(directoryHeaderForOpenCode(encodeURIComponent(UNC), true)).toBe(WIRED);
  });

  it('leaves a drive path and a posix path alone', () => {
    expect(directoryHeaderForOpenCode('C:/repo')).toBe('C:/repo');
    expect(directoryHeaderForOpenCode('/home/ocrunner')).toBe('/home/ocrunner');
    expect(directoryHeaderForOpenCode(encodeURIComponent('/home/ocrunner'))).toBe(encodeURIComponent('/home/ocrunner'));
  });

  it('keeps an unmarked literal percent sequence', () => {
    expect(directoryHeaderForOpenCode('/Users/example/project%20literal')).toBe('/Users/example/project%20literal');
  });

  it('decodes a marked ordinary path', () => {
    expect(directoryHeaderForOpenCode(encodeURIComponent('/Users/example/project'), true)).toBe('/Users/example/project');
  });
});

describe('wireForwardedDirectoryHeaders', () => {
  it('rewrites only the directory header and drops the encoding marker', () => {
    const headers = wireForwardedDirectoryHeaders({
      accept: 'application/json',
      'x-opencode-directory': encodeURIComponent(UNC),
      'x-opencode-directory-encoding': 'uri',
    });

    expect(headers).toEqual({
      accept: 'application/json',
      'x-opencode-directory': WIRED,
    });
  });
});
