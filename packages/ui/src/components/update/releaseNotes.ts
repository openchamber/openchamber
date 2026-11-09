import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getCurrentIntlLocale } from '@/lib/i18n';

const releaseNotesResponseSchema = z.object({
  releases: z.array(z.object({
    version: z.string(),
    /** YYYY-MM-DD */
    date: z.string(),
    title: z.string().nullable(),
    intro: z.string().nullable(),
    /** Non-empty groups in the order the changelog lists them; bullets are Markdown. */
    groups: z.array(z.object({
      key: z.enum(['new', 'improvements', 'fixes', 'sdk', 'misc']),
      bullets: z.array(z.string()).min(1),
    })),
  })),
});

export type ReleaseNotesRelease = z.infer<typeof releaseNotesResponseSchema>['releases'][number];
export type ReleaseNotesGroupKey = ReleaseNotesRelease['groups'][number]['key'];
export type ReleaseNotesContent = Pick<ReleaseNotesRelease, 'title' | 'intro' | 'groups'>;

// The headings the server writes for each group (`lib/changelog/update-notes.js`).
const GROUP_KEY_BY_HEADING = new Map<string, ReleaseNotesGroupKey>([
  ['New', 'new'],
  ['Improvements', 'improvements'],
  ['Fixes', 'fixes'],
  ['SDK', 'sdk'],
  ['Misc', 'misc'],
]);

/**
 * One release of the update dialog's Markdown (`**title**`, intro, then
 * `### Group` and `- bullet` lines) as data, or null for any other shape,
 * such as release notes the desktop updater took from GitHub.
 */
export function parseReleaseNotesMarkdown(content: string): ReleaseNotesContent | null {
  const lines = content.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  let title: string | null = null;
  const intro: string[] = [];
  const groups: ReleaseNotesContent['groups'] = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^### (.+)$/.exec(line)?.[1];
    const current = groups.at(-1);
    if (heading !== undefined) {
      const key = GROUP_KEY_BY_HEADING.get(heading);
      if (!key) return null;
      groups.push({ key, bullets: [] });
    } else if (current) {
      if (!line.startsWith('- ')) return null;
      current.bullets.push(line.slice(2));
    } else if (index === 0 && /^\*\*.+\*\*$/.test(line)) {
      title = line.slice(2, -2);
    } else {
      intro.push(line);
    }
  }
  const filled = groups.filter((group) => group.bullets.length > 0);
  return filled.length > 0 ? { title, intro: intro.length > 0 ? intro.join('\n\n') : null, groups: filled } : null;
}

/**
 * The releases of `version`, newest first: what an update from `since`
 * brings, or `version` alone. Null when the server could not read the notes
 * (offline, GitHub down, a server without the route); an empty list when the
 * changelog has none for it.
 */
export async function fetchReleaseNotes(version: string, since: string | null, signal?: AbortSignal): Promise<ReleaseNotesRelease[] | null> {
  try {
    const response = await runtimeFetch('/api/openchamber/release-notes', {
      query: since ? { version, since } : { version },
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    const parsed = releaseNotesResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.releases : null;
  } catch {
    return null;
  }
}

/** "Nov 8, 2026" for 2026-11-08 in the UI locale; the input as is when it is no date. */
export function formatReleaseDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** Turns @username into a link to the GitHub profile. */
export function linkReleaseNoteMentions(content: string): string {
  return content.replace(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9-]+)/g, '$1[@$2](https://github.com/$2)');
}
