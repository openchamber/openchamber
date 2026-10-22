import { describe, expect, test } from 'bun:test';

import { rewriteProjectUploads } from './projectUploads';

const secret = '66dbcd21ec5d24ed6ea225176098d52b';
const urls = {
  media: (path: string) => `https://app.test/api/source-control/gitlab${path}?owner=team`,
  link: (path: string) => `https://gitlab.test/team/repo${path}`,
};

describe('rewriteProjectUploads', () => {
  test('reads pictures and clips through the server and opens other files on GitLab', () => {
    const markdown = [
      `![demo](/uploads/${secret}/demo.mp4)`,
      `[log.txt](/uploads/${secret}/log.txt) and <a href="/uploads/${secret}/a.pdf">a.pdf</a>`,
      `<img src="/uploads/${secret}/shot.png" width="300">`,
      'See /uploads/ in the docs and ![remote](https://gitlab.com/a.png).',
    ].join('\n\n');

    expect(rewriteProjectUploads(markdown, urls)).toBe([
      `![demo](https://app.test/api/source-control/gitlab/uploads/${secret}/demo.mp4?owner=team)`,
      `[log.txt](https://gitlab.test/team/repo/uploads/${secret}/log.txt) and <a href="https://gitlab.test/team/repo/uploads/${secret}/a.pdf">a.pdf</a>`,
      `<img src="https://app.test/api/source-control/gitlab/uploads/${secret}/shot.png?owner=team" width="300">`,
      'See /uploads/ in the docs and ![remote](https://gitlab.com/a.png).',
    ].join('\n\n'));
  });

  test('keeps upload paths inside code as written', () => {
    const markdown = [
      `Write \`![x](/uploads/${secret}/y.png)\` to embed.`,
      '```md',
      `![x](/uploads/${secret}/y.png)`,
      '```',
      `![real](/uploads/${secret}/z.png)`,
    ].join('\n');

    const result = rewriteProjectUploads(markdown, urls);
    expect(result.split(`(/uploads/${secret}/y.png)`)).toHaveLength(3);
    expect(result).toContain(`![real](https://app.test/api/source-control/gitlab/uploads/${secret}/z.png?owner=team)`);
  });
});
