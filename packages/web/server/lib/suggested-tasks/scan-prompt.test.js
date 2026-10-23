import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, parseConfigEdit, readSuggestedTasksConfig } from './config.js';
import { ScanOutputError, buildScanPrompt, isSimilarTitle, matchesGlob, parseScanOutput, selectSuggestions } from './scan-prompt.js';

const report = (suggestions) => `Here is what I found.\n\n\`\`\`json\n${JSON.stringify({ suggestions })}\n\`\`\``;

const suggestion = (overrides = {}) => ({
  title: 'Remove the unused cache',
  explanation: 'Nothing reads it.',
  files: [{ path: 'src/cache.ts', startLine: 4, endLine: 9 }],
  confidence: 'high',
  severity: 'medium',
  ...overrides,
});

describe('matchesGlob', () => {
  it('matches the way scope patterns are written', () => {
    expect(matchesGlob('src/a/b.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/b.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('lib/b.ts', 'src/**')).toBe(false);
    expect(matchesGlob('deep/dir/file.test.ts', '*.test.ts')).toBe(true);
    expect(matchesGlob('src/file.ts', 'src/*.js')).toBe(false);
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
  });
});

describe('parseScanOutput', () => {
  it('accepts optional evidence and rejects unsafe or malformed evidence per suggestion', () => {
    const evidence = [{ source: 'Jira', summary: 'Reproduction steps', url: 'https://example.com/BUG-1' }];
    const parsed = parseScanOutput(report([
      suggestion({ evidence }), suggestion({ title: 'Old format' }),
      suggestion({ evidence: [{ source: 'Jira', summary: 'bad url', url: 'javascript:alert(1)' }] }),
      suggestion({ evidence: Array.from({ length: 11 }, () => evidence[0]) }),
      suggestion({ evidence: [{ source: '', summary: 'missing source' }] }),
    ]), '/repo');
    expect(parsed.invalid).toBe(3);
    expect(parsed.suggestions[0].evidence).toEqual(evidence);
    expect(parsed.suggestions[1].evidence).toBeUndefined();
  });
  it('reads the last JSON block and makes paths relative to the scanned checkout', () => {
    const text = `${report([{ title: 'stale' }])}\n\nOn second thought:\n${report([
      suggestion({ files: [{ path: '/repo/src/a.ts', startLine: 2 }, { path: './src/b.ts' }, { path: '../outside.ts' }] }),
    ])}`;
    const { suggestions, invalid } = parseScanOutput(text, '/repo');
    expect(invalid).toBe(0);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].files).toEqual([{ path: 'src/a.ts', startLine: 2 }, { path: 'src/b.ts' }]);
    expect(suggestions[0].body).toBe('Nothing reads it.');
  });

  it('treats an empty list as an answer, and a missing block as a failure', () => {
    expect(parseScanOutput(report([]), '/repo')).toEqual({ suggestions: [], invalid: 0 });
    expect(() => parseScanOutput('I looked around and found nothing worth mentioning.', '/repo')).toThrow(ScanOutputError);
    expect(() => parseScanOutput('```json\n{"suggestions": [\n```', '/repo')).toThrow(ScanOutputError);
  });

  it('skips an unreadable entry alone and repairs unknown levels', () => {
    const { suggestions, invalid } = parseScanOutput(report([{ explanation: 'no title' }, suggestion({ confidence: 'certain', severity: 'urgent' })]), '/repo');
    expect(invalid).toBe(1);
    expect(suggestions[0]).toMatchObject({ confidence: 'medium', severity: 'medium' });
  });
});

describe('selectSuggestions', () => {
  const scope = { include: ['src/**'], exclude: ['src/generated/**'], baseBranch: '', incremental: false };
  const limits = { ...DEFAULT_CONFIG.limits, minConfidence: 'medium', minSeverity: 'low' };

  it('deduplicates differently worded findings at overlapping lines, without merging unrelated work there', () => {
    const first = suggestion({ title: 'Fix command injection in /ping handler by validating the host parameter', files: [{ path: 'src/server.js', startLine: 5, endLine: 13 }] });
    const repeated = suggestion({ title: 'Stop passing the /ping host parameter to a shell', files: [{ path: 'src/server.js', startLine: 7, endLine: 12 }] });
    const unrelated = suggestion({ title: 'Add rate limiting to the HTTP server before public exposure', files: [{ path: 'src/server.js', startLine: 1, endLine: 15 }] });
    const result = selectSuggestions({ reported: [repeated, unrelated], scope, limits, knownTitles: [], knownSuggestions: [first], slots: 10 });
    expect(result.suggestions.map((entry) => entry.title)).toEqual([unrelated.title]);
    expect(result.counts.duplicate).toBe(1);
  });

  it('drops out-of-scope, weak and known suggestions, then keeps the most severe up to the free slots', () => {
    const reported = [
      suggestion({ title: 'Fix generated parser', files: [{ path: 'src/generated/parser.ts' }] }),
      suggestion({ title: 'Guess about timing', confidence: 'low' }),
      suggestion({ title: 'Remove the unused cache!' }),
      suggestion({ title: 'Escape shell arguments', severity: 'critical' }),
      suggestion({ title: 'Rename helper', severity: 'low' }),
      suggestion({ title: 'Document the flag', files: [] }),
    ];
    const { suggestions, counts } = selectSuggestions({ reported, scope, limits, knownTitles: ['Remove the unused cache'], slots: 2 });
    expect(suggestions.map((entry) => entry.title)).toEqual(['Escape shell arguments', 'Document the flag']);
    expect(counts).toEqual({ outOfScope: 1, belowMinimum: 1, duplicate: 1, overLimit: 1 });
  });

  it('compares explanations when separate lenses give different names to the same defect', () => {
    const files = [{ path: 'src/invoices.js', startLine: 4, endLine: 5 }];
    const known = suggestion({ title: 'Restrict invoice download to the invoice owner', files,
      body: 'The FIXME notes that downloadInvoice should restrict access to the account that owns the invoice. Currently it matches only by invoice ID, so any authenticated user can download any invoice by guessing its ID. Add an ownership check comparing the invoice account to the request account before returning it.' });
    const repeated = suggestion({ title: 'Enforce invoice ownership in downloadInvoice (IDOR)', files,
      body: 'downloadInvoice looks up an invoice purely by the caller supplied request.params.id and never checks that the requesting account owns it. Any authenticated caller can enumerate ids and read other accounts invoices. Add an ownership check before returning the record and filter by the authenticated account.' });
    const unrelated = suggestion({ title: 'Rate limit invoice download requests', files,
      body: 'The route has no throttling and a bot can exhaust server capacity. Apply a per-client sliding window with a retry delay and return 429 to excessive requests.' });
    const result = selectSuggestions({ reported: [repeated, unrelated], knownSuggestions: [known], knownTitles: [], scope, limits, slots: 10 });
    expect(result.suggestions.map((entry) => entry.title)).toEqual([unrelated.title]);
    expect(result.counts.duplicate).toBe(1);
  });

  it('keeps only the in-scope files of a suggestion', () => {
    const { suggestions } = selectSuggestions({
      reported: [suggestion({ files: [{ path: 'src/a.ts' }, { path: 'src/generated/b.ts' }] })],
      scope, limits, knownTitles: [], slots: 5,
    });
    expect(suggestions[0].files).toEqual([{ path: 'src/a.ts' }]);
  });
});

describe('isSimilarTitle', () => {
  it('matches rewordings that share almost every word', () => {
    expect(isSimilarTitle('Remove the unused cache module', 'remove unused cache module')).toBe(true);
    expect(isSimilarTitle('Remove the unused cache', 'Add a cache for sessions')).toBe(false);
  });
});

describe('buildScanPrompt', () => {
  it('carries the lens, the scope, what is known and why things were rejected', () => {
    const prompt = buildScanPrompt({
      lens: { name: 'Security', prompt: 'Find injection.' },
      scope: { include: ['src/**'], exclude: [], baseBranch: '', incremental: true },
      maxSuggestions: 3,
      changedFiles: ['src/a.ts'],
      known: { open: ['Open one'], handled: ['Taken one'], dismissed: [{ title: 'Rejected one', reason: 'we accept this risk' }], todos: ['Todo one'], issues: ['Existing issue'] },
    });
    expect(prompt).toContain('## Lens: Security\n\nFind injection.');
    expect(prompt).toContain('Only look at files matching: src/**');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('at most 3 suggestions');
    expect(prompt).toContain('[rejected] Rejected one. Reason: we accept this risk');
    expect(prompt).toContain('[being worked on] Taken one');
    expect(prompt).toContain('[todo] Todo one');
    expect(prompt).toContain('[open issue] Existing issue');
  });
});

describe('config', () => {
  it('reads a missing key as the default and a broken one as an error', () => {
    expect(readSuggestedTasksConfig(undefined)).toEqual({ ok: true, config: DEFAULT_CONFIG });
    expect(readSuggestedTasksConfig({ limits: { maxSuggestions: 999 } }).ok).toBe(false);
  });

  it('fills what an older or partial edit leaves out', () => {
    const edit = parseConfigEdit({ enabled: true, lenses: [{ id: 'sec', name: 'Security', prompt: 'Look.' }] });
    expect(edit.lenses[0]).toMatchObject({ enabled: true, action: 'suggest', web: false, model: { useDefaults: true } });
    expect(edit.schedule.kind).toBe('manual');
  });

  it('rejects lenses that cannot run', () => {
    expect(() => parseConfigEdit({ lenses: [{ id: 'a', name: 'A', prompt: 'x', model: { useDefaults: false } }] })).toThrow(/needs a model/);
    expect(() => parseConfigEdit({ lenses: [{ id: 'a', name: 'A', prompt: 'x' }, { id: 'a', name: 'B', prompt: 'y' }] })).toThrow(/unique/);
  });
});
