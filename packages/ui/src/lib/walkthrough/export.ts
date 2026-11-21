import { type I18nKey, type I18nParams, type Locale, LOCALES, getLocaleDirection } from '@/lib/i18n';
import { buildWalkthroughView, mergeRunPatch } from './model';
import type { WalkthroughHunk, WalkthroughObservationKind, WalkthroughResult } from './types';

export type WalkthroughExportFormat = 'markdown' | 'html';

type Translate = (key: I18nKey, params?: I18nParams) => string;

interface ExportRun {
  path: string;
  note: string | null;
  patch: string;
}

interface ExportStop {
  position: number;
  title: string;
  tag: string | null;
  prose: string;
  observations: Array<{ label: string; note: string }>;
  warnings: string[];
  runs: ExportRun[];
}

interface ExportDocument {
  title: string;
  focus: string;
  staleBanner: string | null;
  chapters: Array<{ title: string; blurb: string; stops: ExportStop[] }>;
  uncovered: { title: string; runs: ExportRun[] } | null;
  language: Locale | null;
}

const OBSERVATION_LABEL_KEY = {
  decision: 'walkthrough.observation.decision',
  cost: 'walkthrough.observation.cost',
  limitation: 'walkthrough.observation.limitation',
  asymmetry: 'walkthrough.observation.asymmetry',
  unproven: 'walkthrough.observation.unproven',
} as const satisfies Record<WalkthroughObservationKind, I18nKey>;

const patchHeader = (patch: string): string => {
  const end = patch.indexOf('\n@@');
  return end === -1 ? patch : patch.slice(0, end);
};

const groupHunksByPatch = (hunks: WalkthroughHunk[]): Array<{ path: string; hunks: WalkthroughHunk[] }> => {
  const runs: Array<{ path: string; hunks: WalkthroughHunk[] }> = [];
  for (const hunk of hunks) {
    const last = runs.at(-1)?.hunks.at(-1);
    if (last && last.path === hunk.path && last.scope === hunk.scope && patchHeader(last.patch) === patchHeader(hunk.patch)) {
      runs.at(-1)?.hunks.push(hunk);
      continue;
    }
    runs.push({ path: hunk.path, hunks: [hunk] });
  }
  return runs;
};

const toRuns = (hunks: WalkthroughHunk[], notes: Map<string, string> = new Map()): ExportRun[] => {
  const noted = new Set<string>();
  return groupHunksByPatch(hunks).map((run) => {
    const note = noted.has(run.path) ? null : notes.get(run.path) ?? null;
    noted.add(run.path);
    return { path: run.path, note, patch: mergeRunPatch(run.hunks) };
  });
};

const buildDocument = (result: WalkthroughResult, t: Translate): ExportDocument | null => {
  const view = buildWalkthroughView(result);
  if (!view) return null;
  const routine = new Map((view.walkthrough.routine ?? []).map((entry) => [entry.path, entry.note]));
  return {
    title: view.walkthrough.title,
    focus: view.walkthrough.focus,
    staleBanner: view.isStale ? t('walkthrough.stale.banner', { count: view.staleStopCount }) : null,
    chapters: view.chapters.map(({ chapter, stops }) => ({
      title: chapter.title,
      blurb: chapter.blurb,
      stops: stops.map((stopView) => {
        const warnings: string[] = [];
        if (stopView.isStale) {
          warnings.push(stopView.hunks.length === 0
            ? t('walkthrough.stop.staleAll')
            : t('walkthrough.stop.stalePartial', { count: stopView.missingHunkIds.length }));
        }
        if (stopView.hunks.length === 0) warnings.push(t('walkthrough.stop.noCode'));
        return {
          position: stopView.position,
          title: stopView.stop.title,
          tag: stopView.stop.importance === 'critical'
            ? t('walkthrough.importance.critical')
            : stopView.stop.importance === 'context' ? t('walkthrough.importance.context') : null,
          prose: stopView.stop.prose,
          observations: (stopView.stop.observations ?? []).map((observation) => ({
            label: t(OBSERVATION_LABEL_KEY[observation.kind]),
            note: observation.note,
          })),
          warnings,
          runs: toRuns(stopView.hunks),
        };
      }),
    })),
    uncovered: view.uncoveredHunks.length > 0
      ? { title: t('walkthrough.uncovered.title', { count: view.uncoveredHunks.length }), runs: toRuns(view.uncoveredHunks, routine) }
      : null,
    language: LOCALES.find((locale) => locale === result.language) ?? null,
  };
};

const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const longestBacktickRun = (text: string): number => {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
};

const markdownCodeSpan = (text: string): string => {
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
};

const AUTOLINK_CANDIDATE = /(?:(?<![a-z\d])[a-z][a-z\d+.-]*:\/\/|(?<![a-z\d])www\.)[^\s<]*[^\s<.,:;!?'")\]*_~]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

const escapeMarkdownText = (text: string): string => text.replace(/[\\`*_~<&[]/g, '\\$&');

const markdownInline = (text: string): string => {
  const line = singleLine(text);
  let output = '';
  let cursor = 0;
  for (const match of line.matchAll(AUTOLINK_CANDIDATE)) {
    output += `${escapeMarkdownText(line.slice(cursor, match.index))}${markdownCodeSpan(match[0])}`;
    cursor = match.index + match[0].length;
  }
  return output + escapeMarkdownText(line.slice(cursor));
};

const markdownParagraph = (text: string): string => {
  const escaped = markdownInline(text);
  const numbered = /^(\d+)([.)])/.exec(escaped);
  if (numbered) return `${numbered[1]}\\${numbered[2]}${escaped.slice(numbered[0].length)}`;
  return /^[#>+\-=|]/.test(escaped) ? `\\${escaped}` : escaped;
};

const markdownHeading = (level: number, text: string): string =>
  `${'#'.repeat(level)} ${markdownInline(text).replace(/#$/, '\\#')}`;

const markdownRuns = (runs: ExportRun[]): string[] => runs.flatMap((run) => {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(run.patch) + 1));
  return [
    markdownCodeSpan(run.path.replace(/[\r\n]+/g, ' ')),
    ...(run.note ? [markdownParagraph(run.note)] : []),
    `${fence}diff\n${run.patch.replace(/\n$/, '')}\n${fence}`,
  ];
});

const toMarkdown = (doc: ExportDocument): string => {
  const blocks: string[] = [markdownHeading(1, doc.title)];
  if (doc.focus) blocks.push(markdownParagraph(doc.focus));
  if (doc.staleBanner) blocks.push(`> ${markdownInline(doc.staleBanner)}`);
  for (const chapter of doc.chapters) {
    blocks.push(markdownHeading(2, chapter.title));
    if (chapter.blurb) blocks.push(markdownParagraph(chapter.blurb));
    for (const stop of chapter.stops) {
      blocks.push(markdownHeading(3, `${stop.position}. ${stop.title}`));
      if (stop.tag) blocks.push(`**${markdownInline(stop.tag)}**`);
      if (stop.prose) blocks.push(markdownParagraph(stop.prose));
      if (stop.observations.length > 0) {
        blocks.push(stop.observations.map((observation) => `- **${markdownInline(observation.label)}:** ${markdownInline(observation.note)}`).join('\n'));
      }
      blocks.push(...stop.warnings.map((warning) => `> ${markdownInline(warning)}`));
      blocks.push(...markdownRuns(stop.runs));
    }
  }
  if (doc.uncovered) {
    blocks.push(markdownHeading(2, doc.uncovered.title));
    blocks.push(...markdownRuns(doc.uncovered.runs));
  }
  return `${blocks.join('\n\n')}\n`;
};

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const diffLineClasses = (lines: string[]): string[] => {
  let inHunk = false;
  return lines.map((line) => {
    if (line.startsWith('@@')) {
      inHunk = true;
      return 'hunk';
    }
    if (!inHunk) return 'meta';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return 'ctx';
  });
};

const htmlRuns = (runs: ExportRun[]): string => runs.map((run) => {
  const patchLines = run.patch.replace(/\n$/, '').split('\n');
  const classes = diffLineClasses(patchLines);
  const lines = patchLines
    .map((line, index) => `<span class="${classes[index]}">${escapeHtml(line)}</span>`)
    .join('');
  return [
    `<h4 class="path" dir="ltr">${escapeHtml(run.path)}</h4>`,
    run.note ? `<p class="muted" dir="auto">${escapeHtml(run.note)}</p>` : '',
    `<pre dir="ltr"><code>${lines}</code></pre>`,
  ].join('');
}).join('');

const HTML_STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--tile:#f6f8fa;--edge:#d1d9e0;--add:#dafbe1;--del:#ffebe9;--hunk:#ddf4ff;--warn:#9a6700;--warn-bg:#fff8c5}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--tile:#151b23;--edge:#3d444d;--add:#12261e;--del:#25171c;--hunk:#121d2f;--warn:#d29922;--warn-bg:#272115}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.6em;margin:0 0 8px}h2{font-size:1.25em;margin:40px 0 4px;padding-bottom:6px;border-bottom:1px solid var(--edge)}
h3{font-size:1.05em;margin:28px 0 6px}h4{margin:16px 0 4px;font-size:.85em}
.muted{color:var(--muted)}.num{color:var(--muted);margin-inline-end:6px}
.tag{display:inline-block;font-size:.75em;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--tile);color:var(--muted);margin-inline-start:8px;vertical-align:.1em}
.obs{list-style:none;margin:8px 0;padding:8px 12px;border-radius:8px;background:var(--tile)}.obs .tag{margin-inline:0 6px}
.warn{color:var(--warn);background:var(--warn-bg);padding:6px 10px;border-radius:6px}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:500;text-align:left}
pre{margin:0 0 12px;overflow-x:auto;border:1px solid var(--edge);border-radius:6px;background:var(--tile);font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:left}
pre code{display:block;min-width:max-content}pre span{display:block;min-height:1.45em;padding:0 12px;white-space:pre}.add{background:var(--add)}.del{background:var(--del)}.hunk{background:var(--hunk);color:var(--muted)}.meta{color:var(--muted)}
`;

const toHtml = (doc: ExportDocument): string => {
  const body: string[] = [`<h1 dir="auto">${escapeHtml(doc.title)}</h1>`];
  if (doc.focus) body.push(`<p class="muted" dir="auto">${escapeHtml(doc.focus)}</p>`);
  if (doc.staleBanner) body.push(`<p class="warn" dir="auto">${escapeHtml(doc.staleBanner)}</p>`);
  for (const chapter of doc.chapters) {
    body.push('<section>', `<h2 dir="auto">${escapeHtml(chapter.title)}</h2>`);
    if (chapter.blurb) body.push(`<p class="muted" dir="auto">${escapeHtml(chapter.blurb)}</p>`);
    for (const stop of chapter.stops) {
      body.push(
        '<article>',
        `<h3 dir="auto"><span class="num">${stop.position}</span>${escapeHtml(stop.title)}${stop.tag ? `<span class="tag">${escapeHtml(stop.tag)}</span>` : ''}</h3>`,
      );
      if (stop.prose) body.push(`<p dir="auto">${escapeHtml(stop.prose)}</p>`);
      if (stop.observations.length > 0) {
        body.push(`<ul class="obs">${stop.observations.map((observation) => `<li dir="auto"><span class="tag">${escapeHtml(observation.label)}</span>${escapeHtml(observation.note)}</li>`).join('')}</ul>`);
      }
      body.push(...stop.warnings.map((warning) => `<p class="warn" dir="auto">${escapeHtml(warning)}</p>`));
      body.push(htmlRuns(stop.runs), '</article>');
    }
    body.push('</section>');
  }
  if (doc.uncovered) {
    body.push('<section>', `<h2 dir="auto">${escapeHtml(doc.uncovered.title)}</h2>`, htmlRuns(doc.uncovered.runs), '</section>');
  }
  const languageAttributes = doc.language ? ` lang="${doc.language}" dir="${getLocaleDirection(doc.language)}"` : '';
  return [
    `<!doctype html><html${languageAttributes}><head><meta charset="utf-8">`,
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(singleLine(doc.title))}</title>`,
    `<style>${HTML_STYLE}</style>`,
    `</head><body><main>${body.join('')}</main></body></html>\n`,
  ].join('');
};

const fileBaseName = (title: string): string => {
  const words = title.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+/, '');
  const slug = Array.from(words).slice(0, 60).join('').replace(/-+$/, '');
  return slug ? `walkthrough-${slug}` : 'walkthrough';
};

export const walkthroughExportFile = (result: WalkthroughResult, format: WalkthroughExportFormat, t: Translate): File | null => {
  const doc = buildDocument(result, t);
  if (!doc) return null;
  const name = fileBaseName(doc.title);
  return format === 'markdown'
    ? new File([toMarkdown(doc)], `${name}.md`, { type: 'text/markdown' })
    : new File([toHtml(doc)], `${name}.html`, { type: 'text/html' });
};
