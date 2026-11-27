import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultBundledOpenCodeServerDirectories,
  resolvePackageBundledOpenCodeServerDir,
} from './bundled-opencode-server.js';

const originalPlatform = process.platform;
const originalReportDescriptor = Object.getOwnPropertyDescriptor(process, 'report');

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: originalPlatform,
  });
  if (originalReportDescriptor) {
    Object.defineProperty(process, 'report', originalReportDescriptor);
  }
});

describe('isLinuxMusl caching in bundled-opencode-server', () => {
  it('memoizes process.report.getReport across repeated calls on linux', () => {
    let reportCalls = 0;
    Object.defineProperty(process, 'report', {
      configurable: true,
      value: {
        getReport: () => {
          reportCalls += 1;
          return { header: { glibcVersionRuntime: '2.39' } };
        },
      },
    });

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    expect(resolvePackageBundledOpenCodeServerDir()).toBeNull();
    expect(reportCalls).toBe(0);

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    resolvePackageBundledOpenCodeServerDir();
    expect(reportCalls).toBe(1);

    resolvePackageBundledOpenCodeServerDir();
    defaultBundledOpenCodeServerDirectories();
    expect(reportCalls).toBe(1);
  });
});
