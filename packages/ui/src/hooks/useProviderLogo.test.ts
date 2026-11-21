import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useProviderLogo } from './useProviderLogo';

// Bun does not transform the Vite asset glob, so every provider resolves through the
// remote fallback URL here. Local asset resolution is covered by the Vite smoke check.
const expected = [
    ['glm', 'zhipuai'],
    ['grok', 'xai'],
    ['kimi', 'kimi-for-coding'],
    ['moonshotai', 'kimi-for-coding'],
    ['minimax', 'minimax-coding-plan'],
    ['minimax-cn', 'minimax-cn-coding-plan'],
    ['bailian', 'bailian-coding-plan'],
    ['x-ai', 'xai'],
    ['zhipu-ai', 'zhipuai'],
    ['moonshot-ai', 'kimi-for-coding'],
    ['z-ai', 'zai'],
    ['lm-studio', 'lmstudio'],
    ['open-router', 'openrouter'],
    ['mistral-ai', 'mistral'],
    ['perplexity-ai', 'perplexity'],
    ['together-ai', 'togetherai'],
    ['hugging-face', 'huggingface'],
    ['fireworks', 'fireworks-ai'],
    ['deepseek-ai', 'deepseek'],
    ['cohere-ai', 'cohere'],
];

function LogoSource({ providerId }: { providerId: string }) {
    return useProviderLogo(providerId).src;
}

const renderLogoSrc = (providerId: string) =>
    renderToStaticMarkup(createElement(LogoSource, { providerId }));

describe('provider logo aliases', () => {
    for (const [id, target] of expected) {
        test(id + ' uses ' + target + ' across case and spacing variants', () => {
            const variants = new Set([id, id.toUpperCase(), id.charAt(0).toUpperCase() + id.slice(1), id.replaceAll('-', ' ')]);
            for (const variant of variants) {
                expect(renderLogoSrc(variant)).toBe('https://models.dev/logos/' + target + '.svg');
            }
        });
    }

    test('keeps decorated provider IDs and existing aliases', () => {
        expect(renderLogoSrc('my-glm')).toBe('https://models.dev/logos/my-glm.svg');
        expect(renderLogoSrc('my-minimax')).toBe('https://models.dev/logos/my-minimax.svg');
        expect(renderLogoSrc('copilot')).toBe('https://models.dev/logos/github-copilot.svg');
        expect(renderLogoSrc('exe-example')).toBe('https://models.dev/logos/exe-dev.svg');
    });
});
