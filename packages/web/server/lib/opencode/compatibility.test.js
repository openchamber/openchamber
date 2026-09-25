import { describe, it, expect } from 'vitest';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion, readOpenCodeInfo, requireOpenCodeV2, UnsupportedOpenCodeVersionError } from './compatibility.js';

const cli = (output, code = 0) => ({ binary: process.execPath, args: ['-e', `console.log(${JSON.stringify(output)}); process.exit(${code})`, '--'] });

describe('OpenCode compatibility', () => {
  it('recognizes both CLI version formats before launching a server', async () => {
    expect(await readOpenCodeCliVersion(cli('1.18.32'))).toBe('1.18.32');
    expect(await requireOpenCodeV2(cli('opencode v2.0.15'))).toBe('2.0.15');
    await expect(requireOpenCodeV2(cli('2.0.14'))).rejects.toBeInstanceOf(UnsupportedOpenCodeVersionError);
    await expect(requireOpenCodeV2(cli('1.18.32'))).rejects.toBeInstanceOf(UnsupportedOpenCodeVersionError);
    await expect(readOpenCodeCliVersion(cli('2.0.14', 1))).rejects.toThrow();
    await expect(readOpenCodeCliVersion(cli('error, requires 2.0.14'))).rejects.toThrow();
  });

  it('does not accept HTTP 200 HTML or malformed JSON as readiness', async () => {
    expect(await readOpenCodeInfo(new Response('<html>OpenCode</html>'))).toBeNull();
    expect(await readOpenCodeInfo(Response.json({ healthy: true }))).toBeNull();
    expect(await readOpenCodeInfo(Response.json({ version: 'not a version' }))).toBeNull();
    expect(await readOpenCodeInfo(Response.json({ version: '2.0.14' }))).toEqual({ version: '2.0.14' });
  });

  it('identifies external v1 through its legacy health contract', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url.pathname);
      return url.pathname === '/api/info' ? new Response('<html/>') : Response.json({ healthy: true, version: '1.18.32' });
    };
    expect(await readExternalOpenCodeVersion('http://localhost:4096', {}, fetchImpl)).toBe('1.18.32');
    expect(requests).toEqual(['/api/info', '/global/health']);
  });

  it('still identifies v1 when its /api/info fallback hangs or fails', async () => {
    const fetchImpl = async (url) => {
      if (url.pathname === '/api/info') throw new DOMException('The operation timed out.', 'TimeoutError');
      return Response.json({ healthy: true, version: '1.18.32' });
    };
    expect(await readExternalOpenCodeVersion('http://localhost:4096', {}, fetchImpl)).toBe('1.18.32');
  });

  it.each([401, 403])('does not call an auth failure v1 (%s)', async (status) => {
    let requests = 0;
    expect(await readExternalOpenCodeVersion('http://localhost:4096', {}, async () => {
      requests += 1;
      return new Response(null, { status });
    })).toBeNull();
    expect(requests).toBe(1);
  });

  it('accepts 2.x from the minimum on and nothing older or of another major', () => {
    for (const version of ['2.0.15', '2.0.16', '2.1.0', '2.0.15-beta.1']) {
      expect(describeOpenCodeCompatibility(version, 'managed', true).state).toBe('compatible');
    }
    for (const version of ['1.18.32', '2.0.14', '2.0.9', '3.0.0']) {
      expect(describeOpenCodeCompatibility(version, 'managed', true).state).toBe('incompatible');
    }
    expect(describeOpenCodeCompatibility('2.0.14', 'managed', true).minimumVersion).toBe('2.0.15');
  });

  it('only offers installation for a known managed CLI older than the minimum', () => {
    expect(describeOpenCodeCompatibility('1.18.32', 'managed', true)).toMatchObject({ state: 'incompatible', canInstall: true });
    expect(describeOpenCodeCompatibility('2.0.14', 'managed', true)).toMatchObject({ state: 'incompatible', canInstall: true });
    for (const installation of ['external', 'bundled']) {
      expect(describeOpenCodeCompatibility('1.18.32', installation, true).canInstall).toBe(false);
    }
    for (const version of [null, '2.0.15', '3.0.0']) {
      expect(describeOpenCodeCompatibility(version, 'managed', true).canInstall).toBe(false);
    }
  });
});
