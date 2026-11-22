import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { unknownProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { ProviderIcon } from './ProviderIcon';
import { providerIconSrc } from './providerIconSprite';

describe('ProviderIcon', () => {
  test('draws the sprite the descriptor names, its filled mark when asked', () => {
    expect(renderToStaticMarkup(<ProviderIcon descriptor={githubLikeDescriptor()} />)).toContain('href="#oc-github"');
    expect(renderToStaticMarkup(<ProviderIcon descriptor={githubLikeDescriptor()} variant="fill" />)).toContain('href="#oc-github-fill"');
    // A provider without a filled mark keeps its line mark.
    expect(renderToStaticMarkup(<ProviderIcon descriptor={gitlabLikeDescriptor()} variant="fill" />)).toContain('href="#oc-gitlab"');
  });

  test('draws a served path when the sprite does not carry the mark, else the branch icon', () => {
    const markup = renderToStaticMarkup(<ProviderIcon descriptor={acmeDescriptor()} className="size-4" />);
    expect(markup).toContain('<path d="M12 2L2 22h20L12 2z" fill="currentColor">');
    expect(markup).toContain('size-4');
    expect(renderToStaticMarkup(<ProviderIcon descriptor={acmeDescriptor({ icon: { sprite: 'no-such-icon' } })} />))
      .toContain('href="#oc-git-branch"');
    expect(renderToStaticMarkup(<ProviderIcon descriptor={unknownProviderDescriptor('sourcehut')} />)).toContain('href="#oc-git-branch"');
  });

  test('serves the same mark as a data URI for surfaces that take an icon URL', () => {
    const decode = (src: string) => decodeURIComponent(src.replace('data:image/svg+xml,', ''));
    expect(decode(providerIconSrc(acmeDescriptor()))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2z" fill="currentColor"/></svg>',
    );
    expect(providerIconSrc(gitlabLikeDescriptor()).startsWith('data:image/svg+xml,')).toBe(true);
    expect(decode(providerIconSrc(unknownProviderDescriptor('sourcehut')))).toContain('<path');
  });
});
