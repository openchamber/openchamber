import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { providerLogoIds, useProviderLogo } from './useProviderLogo';

// Bun does not transform the Vite asset glob, so every provider resolves through the
// remote fallback URL here. Local asset resolution is covered by the Vite smoke check.
// [provider ID, logo target, remote fallback when it differs from the target]
const expected: [string, string, string?][] = [
    ['glm', 'zhipuai-coding-plan'],
    ['grok', 'xai'],
    ['kimi', 'kimi-for-coding', 'moonshotai'],
    ['moonshotai', 'kimi-for-coding', 'moonshotai'],
    ['minimax', 'minimax-coding-plan'],
    ['minimax-cn', 'minimax-cn-coding-plan'],
    ['bailian', 'bailian-coding-plan'],
    ['x-ai', 'xai'],
    ['zhipu-ai', 'zhipuai-coding-plan'],
    ['moonshot-ai', 'kimi-for-coding', 'moonshotai'],
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
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(providerLogoIds('exe-proxy-123')[1]).toBe('exe-dev');
    });

    test('aliases the copilot provider id to the bundled github-copilot logo', () => {
        expect(providerLogoIds('copilot')[1]).toBe('github-copilot');
    });
});

describe('provider logo lookup order', () => {
    for (const [id, target, remote = target] of expected) {
        test(id + ' uses ' + target + ' across case and spacing variants', () => {
            const variants = new Set([id, id.toUpperCase(), id.charAt(0).toUpperCase() + id.slice(1), id.replaceAll('-', ' ')]);
            for (const variant of variants) {
                expect(renderLogoSrc(variant)).toBe('https://models.dev/logos/' + remote + '.svg');
            }
        });
    }

    test('brand aliases stay out of the extension logo lookup', () => {
        for (const [id, target] of expected) {
            expect(providerLogoIds(id)).not.toContain(target);
        }
        expect(providerLogoIds('GLM')).toEqual(['GLM', 'glm']);
    });

    test('keeps decorated provider IDs and existing aliases', () => {
        expect(renderLogoSrc('my-glm')).toBe('https://models.dev/logos/my-glm.svg');
        expect(renderLogoSrc('my-minimax')).toBe('https://models.dev/logos/my-minimax.svg');
        expect(renderLogoSrc('copilot')).toBe('https://models.dev/logos/github-copilot.svg');
        expect(renderLogoSrc('exe-example')).toBe('https://models.dev/logos/exe-dev.svg');
    });
});
