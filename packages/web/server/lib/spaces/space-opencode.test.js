import { describe, expect, it } from 'vitest';

import { WINDOW_PLACEHOLDER_KEY, buildProviderConfig, createSpaceOpenCode } from './space-opencode.js';

const ID = 'a1b2c3d4e5f6';
const GRANTS = [
  { kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', source: { kind: 'typed' } },
  { kind: 'domain', id: 'open-0a1b2c3d4e5f', upstream: 'https://registry.example.com/npm/' },
  { kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'OPENAI_API_KEY' } },
];

describe('the provider configuration inside a space', () => {
  it('names each granted provider as the host does, at the window, with a placeholder key, and leaves domains out', () => {
    expect(buildProviderConfig(GRANTS)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        anthropic: { options: { baseURL: 'http://gatekeeper:8080/model/anthropic', apiKey: WINDOW_PLACEHOLDER_KEY } },
        openai: { options: { baseURL: 'http://gatekeeper:8080/model/openai', apiKey: WINDOW_PLACEHOLDER_KEY } },
      },
    });
    expect(buildProviderConfig([])).toEqual({ $schema: 'https://opencode.ai/config.json', provider: {} });
    // The upstream is the gatekeeper's business; nothing of it is written where the agent reads.
    expect(JSON.stringify(buildProviderConfig(GRANTS))).not.toContain('api.anthropic.com');
  });

  it('writes the whole file over exec, as JSON on stdin, through a temporary name', async () => {
    const calls = [];
    const opencode = createSpaceOpenCode({ exec: async (spaceId, argv, options) => { calls.push({ spaceId, argv, options }); return { code: 0, stdout: '', stderr: '' }; } });
    await opencode.writeProviderConfig(ID, GRANTS);
    expect(calls).toEqual([{
      spaceId: ID,
      argv: ['/bin/sh', '-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; mkdir -p /home/space/.config/opencode && cat > /home/space/.config/opencode/opencode.json.new && mv /home/space/.config/opencode/opencode.json.new /home/space/.config/opencode/opencode.json'],
      options: { stdin: `${JSON.stringify(buildProviderConfig(GRANTS), null, 2)}\n` },
    }]);
  });

  it('says what failed inside', async () => {
    const opencode = createSpaceOpenCode({ exec: async () => ({ code: 1, stdout: '', stderr: 'sh: cannot create: Read-only file system\n' }) });
    await expect(opencode.writeProviderConfig(ID, GRANTS)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('Read-only file system') });
  });
});
