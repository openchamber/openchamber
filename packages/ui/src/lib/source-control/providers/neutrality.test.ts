import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared UI names no source-control or tracker provider in its logic: a
 * provider the server adds shows up on every surface from its descriptor
 * alone. This guard reads every non-test source file under `packages/ui/src`.
 * The web adapter's legacy wire lives in `packages/web` and is not scanned.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Ids of providers the server ships today. A comparison against one of them,
// on any expression, picks behavior by provider instead of by descriptor.
const KNOWN_PROVIDER_IDS = ['github', 'gitlab', 'gitea', 'linear'];
const ID_ALTERNATION = KNOWN_PROVIDER_IDS.join('|');
const KNOWN_ID_COMPARISON = new RegExp(`[!=]==?\\s*['"\`](?:${ID_ALTERNATION})['"\`]|['"\`](?:${ID_ALTERNATION})['"\`]\\s*[!=]==?|case\\s+['"\`](?:${ID_ALTERNATION})['"\`]\\s*:`);
// Any string-literal comparison on a value named `provider` (`provider`, `x.provider`),
// except a `typeof` check.
const PROVIDER_LITERAL_COMPARISON = /(typeof\s+)?[\w?.]*\bprovider\s*[!=]==?\s*['"`]|['"`][^'"`\n]*['"`]\s*[!=]==?\s*[\w?.]*\bprovider\b/g;
const GITEA = /gitea/i;

/**
 * Files that may match, each with the reason. Every entry must still match,
 * so the list cannot outlive the code it excuses.
 */
type AllowlistEntry = { rule: 'gitea' | 'comparison'; reason: string };

const ALLOWLIST = {
  'lib/fileTypeIconIds.ts': {
    rule: 'gitea',
    reason: 'Generated file-icon theme ids (`folder-gitea`): a folder icon, not a provider.',
  },
  'components/sections/openchamber/TunnelSettings.tsx': {
    rule: 'comparison',
    reason: 'Tunnel providers (cloudflare, ngrok), not source control or trackers.',
  },
  'lib/settings/parsers.ts': {
    rule: 'comparison',
    reason: 'Legacy voice provider values (server, browser, wasm) in stored settings.',
  },
  'lib/opencode/websearch.ts': {
    rule: 'comparison',
    reason: 'Web search provider selection (`random`), not source control or trackers.',
  },
  'components/chat/permissionToolPresentation.tsx': {
    rule: 'comparison',
    reason: 'OpenCode tool names of the Linear MCP server (`linear`, `linear_*`), not a tracker id.',
  },
  'components/chat/message/parts/toolPresentation.tsx': {
    rule: 'comparison',
    reason: 'OpenCode tool names of the Linear MCP server (`linear`, `linear_*`), not a tracker id.',
  },
} satisfies Record<string, AllowlistEntry>;

const isTestSource = (path: string): boolean => (
  /\.(test|spec)\.tsx?$/.test(path)
  || /\.fixture\.tsx?$/.test(path)
  || path.split('/').includes('__tests__')
);

const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
  return /\.tsx?$/.test(entry.name) ? [path] : [];
});

const findings = (rule: 'gitea' | 'comparison', text: string): string[] => {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    const where = `${index + 1}: ${line.trim()}`;
    if (rule === 'gitea') return GITEA.test(line) ? [where] : [];
    if (KNOWN_ID_COMPARISON.test(line)) return [where];
    const providerComparison = [...line.matchAll(PROVIDER_LITERAL_COMPARISON)].some((match) => !match[1]);
    return providerComparison ? [where] : [];
  });
};

describe('provider neutrality of the shared UI', () => {
  const files = sourceFiles(SRC)
    .map((path) => relative(SRC, path).split(sep).join('/'))
    .filter((path) => !isTestSource(path));

  test('scans the shared UI sources', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('lib/source-control/providers/registry.ts');
  });

  for (const rule of ['gitea', 'comparison'] as const) {
    test(rule === 'gitea'
      ? 'no source file names gitea'
      : 'no source file compares a provider against a string literal', () => {
      const unexpected: string[] = [];
      for (const path of files) {
        const found = findings(rule, readFileSync(join(SRC, path), 'utf8'));
        const allowed = Object.entries(ALLOWLIST).some(([file, entry]) => file === path && entry.rule === rule);
        if (found.length > 0 && !allowed) unexpected.push(...found.map((line) => `${path}:${line}`));
      }
      expect(unexpected).toEqual([]);
    });
  }

  test('every allowlisted file still needs its entry', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([path, { rule }]) => findings(rule, readFileSync(join(SRC, path), 'utf8')).length === 0)
      .map(([path]) => path);
    expect(stale).toEqual([]);
  });
});
