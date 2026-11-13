import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadRelease, findRelease } from './release.js';

const digest = (content) => createHash('sha256').update(content).digest('hex');
const answer = (body, status = 200) => async () => new Response(body, { status });
const json = (value) => answer(JSON.stringify(value));
const asset = (name, extra = {}) => ({ name, browser_download_url: `https://example.test/${name}`, digest: `sha256:${'a'.repeat(64)}`, ...extra });

describe('host release lookup', () => {
  it('picks the web package of the release version and its recorded digest', async () => {
    const release = await findRelease({
      repo: 'example/openchamber',
      fetchImpl: json({ tag_name: 'v2.7.0', assets: [asset('openchamber-sdk-2.7.0.tgz'), asset('openchamber-web-2.6.9.tgz'), asset('openchamber-web-2.7.0.tgz')] }),
    });
    expect(release).toEqual({ version: '2.7.0', url: 'https://example.test/openchamber-web-2.7.0.tgz', sha256: 'a'.repeat(64) });
  });

  it('refuses a package GitHub recorded no digest for', async () => {
    const result = findRelease({ repo: 'example/openchamber', fetchImpl: json({ tag_name: 'v2.7.0', assets: [asset('openchamber-web-2.7.0.tgz', { digest: null })] }) });
    await expect(result).rejects.toMatchObject({ code: 'digest_missing' });
  });

  it('reports an unreachable release as a failure', async () => {
    await expect(findRelease({ repo: 'example/openchamber', fetchImpl: answer('', 503) })).rejects.toMatchObject({ code: 'release_unavailable' });
  });

  it('keeps a download only when its digest matches', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'host-release-'));
    try {
      const file = path.join(directory, 'package.tgz');
      await downloadRelease({ url: 'https://example.test/p.tgz', sha256: digest('good') }, file, { fetchImpl: answer('good') });
      expect(await fs.readFile(file, 'utf8')).toBe('good');
      const tampered = downloadRelease({ url: 'https://example.test/p.tgz', sha256: digest('good') }, file, { fetchImpl: answer('evil') });
      await expect(tampered).rejects.toMatchObject({ code: 'digest_mismatch' });
      expect(await fs.stat(file).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
