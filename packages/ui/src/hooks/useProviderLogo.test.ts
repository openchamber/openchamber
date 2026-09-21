import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./useProviderLogo.ts', import.meta.url), 'utf8');

describe('provider logo aliases', () => {
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(source).toContain("compact.startsWith('exe-') ? 'exe-dev' : undefined");
        expect(source).toContain('const candidates = [prefixAlias,');
    });
});
