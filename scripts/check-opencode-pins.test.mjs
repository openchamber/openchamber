import { describe, expect, test } from 'bun:test';
import { checkOpencodePins, readDockerCliPin, readOpencodePins } from './check-opencode-pins.mjs';

describe('bundled OpenCode pins', () => {
  test('the Docker image and both workspace manifests pin the same version', () => {
    const pins = readOpencodePins();
    const result = checkOpencodePins(pins);
    if (!result.ok) {
      throw new Error(
        `OpenCode pins disagree: ${JSON.stringify(pins)}. Update Dockerfile, package.json and packages/electron/package.json together.`,
      );
    }
  });

  test('reports a version that drifted', () => {
    expect(checkOpencodePins({ dockerCli: '2.3.0', workspaceClient: '2.3.0', desktopServer: '2.3.2' }))
      .toMatchObject({ ok: false, reason: 'mismatch' });
  });

  test('reports a pin it could not read', () => {
    expect(checkOpencodePins({ dockerCli: null, workspaceClient: '2.3.0', desktopServer: '2.3.0' }))
      .toMatchObject({ ok: false, reason: 'missing', missing: ['dockerCli'] });
  });

  test('reads the Docker pin from the install command, never from a comment', () => {
    const dockerfile = [
      '# npm install -g @opencode/cli@2.3.2 matches the bundled server',
      'RUN apt-get update && \\',
      '  npm install -g @opencode/cli@2.3.0',
    ].join('\n');
    expect(readDockerCliPin(dockerfile)).toBe('2.3.0');
  });

  test('ignores an install command left in an inline comment', () => {
    expect(readDockerCliPin('RUN apt-get install -y git # npm install -g @opencode/cli@2.3.2')).toBe(null);
  });

  test('treats two different Docker install pins as unreadable', () => {
    const dockerfile = 'RUN npm install -g @opencode/cli@2.3.0\nRUN npm install -g @opencode/cli@2.3.2';
    expect(readDockerCliPin(dockerfile)).toBe(null);
  });
});
