import { describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_CLIENT_VERSION,
  antigravityHeaders,
  antigravityUserAgent,
  warnIfGeminiGroupMissing
} from './client.js';

describe('Antigravity client identity', () => {
  it('names the current client version and the machine it runs on', () => {
    expect(antigravityUserAgent('win32', 'x64')).toBe(`antigravity/${ANTIGRAVITY_CLIENT_VERSION} windows/amd64`);
    expect(antigravityUserAgent('darwin', 'arm64')).toBe(`antigravity/${ANTIGRAVITY_CLIENT_VERSION} darwin/arm64`);
    expect(antigravityUserAgent('linux', 'x64')).toBe(`antigravity/${ANTIGRAVITY_CLIENT_VERSION} linux/amd64`);
  });

  it('keeps the long-standing platform pair for a machine Antigravity does not ship for', () => {
    expect(antigravityUserAgent('freebsd', 'x64')).toBe(`antigravity/${ANTIGRAVITY_CLIENT_VERSION} windows/amd64`);
    expect(antigravityUserAgent('linux', 'ia32')).toBe(`antigravity/${ANTIGRAVITY_CLIENT_VERSION} linux/amd64`);
  });

  it('sends a client version newer than the one Google stopped serving Gemini quota to', () => {
    const [major] = ANTIGRAVITY_CLIENT_VERSION.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(2);
    expect(antigravityHeaders()['User-Agent']).toBe(antigravityUserAgent());
    expect(antigravityHeaders()['User-Agent']).not.toContain('1.11.5');
  });

  it('warns once when the summary has groups but none for Gemini', () => {
    const warn = vi.fn();
    const claudeOnly = { groups: [{ displayName: 'Claude and GPT models', buckets: [] }] };
    const both = { groups: [{ displayName: 'Gemini Models' }, { displayName: 'Claude and GPT models' }] };

    warnIfGeminiGroupMissing(null, warn);
    warnIfGeminiGroupMissing({ groups: [] }, warn);
    warnIfGeminiGroupMissing(both, warn);
    expect(warn).not.toHaveBeenCalled();

    warnIfGeminiGroupMissing(claudeOnly, warn);
    warnIfGeminiGroupMissing(claudeOnly, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no Gemini quota group');
    expect(warn.mock.calls[0][0]).toContain(ANTIGRAVITY_CLIENT_VERSION);
  });
});
